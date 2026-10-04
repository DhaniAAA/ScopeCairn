import type { DatabaseSync } from "node:sqlite";
import { tokenizeTask } from "./tokenize.js";
import { seedSearch } from "./symbolIndex.js";
import { gitSignals } from "./git.js";
import { loadConfig, loadGlossary, type RetrievalConfig } from "./config.js";

export interface RankedSymbol {
  id: number;
  name: string;
  type: string;
  file: string;
  signature: string;
  score: number;
  parts: { seed: number; proximity: number; centrality: number; recency: number; cochange: number };
  reason: string;
}

export interface RetrievalResult {
  tokens: string[];
  seeds: number[];
  ranked: RankedSymbol[];
  config: RetrievalConfig;
  gitAvailable: boolean;
}

function expandGlossary(tokens: string[], glossary: Map<string, string[]>): string[] {
  const out = new Set(tokens);
  for (const t of tokens) {
    for (const a of glossary.get(t) ?? []) out.add(a);
    // reverse lookup: token is an alias of some term
    for (const [term, aliases] of glossary) {
      if (aliases.includes(t)) out.add(term);
    }
  }
  return [...out];
}

// SEED → EXPAND → RANK (PRD FR-04 / FR-05).
export interface RetrieveOptions {
  topN?: number;
  maxDepth?: number;
  /** Override bobot untuk tuning/benchmark ( Fase 6 ) tanpa menyentuh config.yml. */
  weights?: Partial<Pick<RetrievalConfig, "wSeed" | "wProximity" | "wCentrality" | "wRecency" | "wCochange">>;
}

export function retrieve(
  db: DatabaseSync,
  repoRoot: string,
  task: string,
  opts?: RetrieveOptions
): RetrievalResult {
  const config = loadConfig(repoRoot);
  if (opts?.topN) config.topN = opts.topN;
  if (opts?.maxDepth) config.maxDepth = opts.maxDepth;
  if (opts?.weights) Object.assign(config, opts.weights);

  const baseTokens = tokenizeTask(task);
  const tokens = expandGlossary(baseTokens, loadGlossary(repoRoot));
  const seeds = seedSearch(db, tokens);
  const seedScore = new Map(seeds.map((s) => [s.symbolId, s.bm25]));

  // EXPAND: BFS dari seed via relationships, bobot menurun per hop.
  const proximity = new Map<number, number>();
  const visited = new Set<number>();
  let frontier = seeds.map((s) => s.symbolId);
  seeds.forEach((s) => {
    proximity.set(s.symbolId, Math.max(proximity.get(s.symbolId) ?? 0, s.bm25));
    visited.add(s.symbolId);
  });
  // EXPAND: BFS berlapis — tiap hop hanya mengambil edge yang dikunjungi
  // via SQL (skala: proporsional derajat seed, bukan total edge).
  // Matematika skor identik dengan versi load-semua: base * w * decay^hop.
  const CHUNK = 2000;
  function neighborsOf(ids: number[]): { from: number; to: number; w: number }[] {
    const out: { from: number; to: number; w: number }[] = [];
    for (let i = 0; i < ids.length; i += CHUNK) {
      const c = ids.slice(i, i + CHUNK);
      const ph = c.map(() => "?").join(",");
      for (const r of db
        .prepare(
          `SELECT source_id AS f, target_id AS t, weight AS w FROM relationships WHERE source_id IN (${ph})`
        )
        .all(...c) as { f: number; t: number; w: number }[]) {
        out.push({ from: r.f, to: r.t, w: r.w });
      }
      for (const r of db
        .prepare(
          `SELECT target_id AS f, source_id AS t, weight * 0.8 AS w FROM relationships WHERE target_id IN (${ph})`
        )
        .all(...c) as { f: number; t: number; w: number }[]) {
        out.push({ from: r.f, to: r.t, w: r.w });
      }
    }
    return out;
  }
  let hopScore = 1;
  for (let depth = 1; depth <= config.maxDepth; depth++) {
    hopScore *= config.decayPerHop;
    const next: number[] = [];
    for (const e of neighborsOf(frontier)) {
      const base = proximity.get(e.from) ?? 0;
      const cand = base * e.w * hopScore;
      if (cand > (proximity.get(e.to) ?? 0)) proximity.set(e.to, cand);
      if (!visited.has(e.to)) {
        visited.add(e.to);
        next.push(e.to);
      }
    }
    frontier = next;
    if (frontier.length === 0) break;
  }

  // Centrality: fan-in (jumlah relasi masuk) ternormalisasi.
  const fanin = new Map<number, number>();
  let maxFan = 1;
  for (const r of db
    .prepare(`SELECT target_id AS id, COUNT(*) AS n FROM relationships GROUP BY target_id`)
    .all() as { id: number; n: number }[]) {
    fanin.set(r.id, r.n);
    if (r.n > maxFan) maxFan = r.n;
  }

  // Seed files untuk sinyal git.
  const seedFiles = new Set<string>();
  if (seeds.length > 0) {
    const ph = seeds.map(() => "?").join(",");
    for (const r of db
      .prepare(`SELECT DISTINCT f.path AS p FROM symbols s JOIN files f ON f.id = s.file_id WHERE s.id IN (${ph})`)
      .all(...seeds.map((s) => s.symbolId)) as { p: string }[]) {
      seedFiles.add(r.p);
    }
  }
  const git = gitSignals(repoRoot, [...seedFiles]);

  // RANK: gabungkan 5 sinyal.
  const meta = new Map<number, { name: string; type: string; file: string; signature: string }>();
  if (visited.size > 0) {
    const ph = [...visited].map(() => "?").join(",");
    for (const r of db
      .prepare(
        `SELECT s.id, s.name, s.type, s.signature, f.path AS file FROM symbols s
         JOIN files f ON f.id = s.file_id WHERE s.id IN (${ph})`
      )
      .all(...[...visited]) as { id: number; name: string; type: string; signature: string; file: string }[]) {
      meta.set(r.id, r);
    }
  }
  const ranked: RankedSymbol[] = [];
  let skippedFiles = 0;
  for (const [id, prox] of proximity) {
    const m = meta.get(id);
    if (!m) continue;
    if (m.type === "file") {
      skippedFiles++;
      continue; // file diringkas dari simbolnya — kecuali fallback di bawah
    }
    const seed = seedScore.get(id) ?? 0;
    const centrality = (fanin.get(id) ?? 0) / maxFan;
    const recency = git.recency.get(m.file) ?? 0;
    const cochange = git.cochange.get(m.file) ?? 0;
    const score =
      config.wSeed * seed +
      config.wProximity * Math.min(1, prox) +
      config.wCentrality * centrality +
      config.wRecency * recency +
      config.wCochange * cochange;
    const why: string[] = [];
    if (seed > 0.05) why.push("seed");
    if (prox > 0.05 && seed <= 0.05) why.push("graph");
    if (centrality > 0.3) why.push("central");
    if (recency > 0.5) why.push("recent");
    if (cochange > 0.3) why.push("co-change");
    ranked.push({
      id,
      name: m.name,
      type: m.type,
      file: m.file,
      signature: m.signature,
      score,
      parts: { seed, proximity: Math.min(1, prox), centrality, recency, cochange },
      reason: why.join("+") || "graph",
    });
  }
  ranked.sort((a, b) => b.score - a.score);
  // Fallback: bila hanya simpul file yang cocok (mis. package.json, skema) —
  // kembalikan file itu agar Protected/scope tetap terlihat.
  if (ranked.length === 0 && skippedFiles > 0) {
    const fileSeeds = seeds
      .map((s) => ({ id: s.symbolId, seed: s.bm25, m: meta.get(s.symbolId) }))
      .filter((s) => s.m && s.m.type === "file")
      .sort((a, b) => b.seed - a.seed)
      .slice(0, 5);
    for (const f of fileSeeds) {
      ranked.push({
        id: f.id,
        name: f.m!.name,
        type: "file",
        file: f.m!.file,
        signature: "",
        score: config.wSeed * f.seed + 0.05,
        parts: { seed: f.seed, proximity: 0, centrality: 0, recency: 0, cochange: 0 },
        reason: "seed",
      });
    }
  }
  return { tokens, seeds: seeds.map((s) => s.symbolId), ranked: ranked.slice(0, config.topN), config, gitAvailable: git.available };
}
