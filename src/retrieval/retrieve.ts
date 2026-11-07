import type { DatabaseSync } from "node:sqlite";
import { tokenizeTask } from "./tokenize.js";
import { seedSearch } from "./symbolIndex.js";
import { gitSignalsFor } from "./git.js";
import { loadConfig, loadGlossary, type RetrievalConfig } from "./config.js";
import { findVerifiedAnalogs, type VerifiedAnalog } from "./verified.js";

export interface RankedSymbol {
  id: number;
  name: string;
  type: string;
  file: string;
  signature: string;
  startLine?: number;
  endLine?: number;
  score: number;
  parts: {
    seed: number;
    proximity: number;
    centrality: number;
    recency: number;
    cochange: number;
    ppr?: number;
    pr?: number;
    verified?: number;
  };
  reason: string;
}

export interface RetrievalResult {
  tokens: string[];
  seeds: number[];
  ranked: RankedSymbol[];
  config: RetrievalConfig;
  gitAvailable: boolean;
  verifiedAnalogs?: VerifiedAnalog[];
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

// Batas placeholder untuk query `IN (...)`. SQLite membatasi jumlah variabel
// terikat per statement (999 di build lama, 32766 di build modern). Repo besar
// bisa punya >30k simbol yang terjangkau dalam maxDepth hop, jadi query
// dibelah. 900 aman di semua build.
const SQL_VAR_CHUNK = 900;

/**
 * Fan-in per simbol (jumlah relasi masuk).
 * Sumber utama: cache `fanin` — diisi scanRepository dalam satu lintasan
 * GROUP BY. Fallback ke hitung langsung bila cache belum ada (DB lama yang
 * belum di-scan ulang), lalu cache diisi agar panggilan berikutnya cepat.
 */
function loadFanin(db: DatabaseSync): Map<number, number> {
  const fanin = new Map<number, number>();
  let rows: { id: number; n: number }[] = [];
  try {
    rows = db.prepare(`SELECT node_id AS id, n FROM fanin`).all() as { id: number; n: number }[];
  } catch {
    rows = [];
  }
  if (rows.length === 0) {
    rows = db
      .prepare(`SELECT target_id AS id, COUNT(*) AS n FROM relationships GROUP BY target_id`)
      .all() as { id: number; n: number }[];
    try {
      db.exec(`DELETE FROM fanin`);
      const ins = db.prepare(`INSERT INTO fanin(node_id, n) VALUES (?, ?)`);
      db.exec("BEGIN");
      for (const r of rows) ins.run(r.id, r.n);
      db.exec("COMMIT");
    } catch {
      // cache bersifat opsional — abaikan kegagalan
    }
  }
  for (const r of rows) fanin.set(r.id, r.n);
  return fanin;
}

/** PageRank per simbol dari `node_metrics` (0 bila tabel belum ada). */
function loadPagerank(db: DatabaseSync): Map<number, number> {
  const m = new Map<number, number>();
  try {
    const rows = db
      .prepare(`SELECT node_id AS id, pagerank AS pr FROM node_metrics`)
      .all() as { id: number; pr: number }[];
    for (const r of rows) m.set(r.id, r.pr);
  } catch {
    // tabel belum ada / belum dihitung — centrality jatuh ke fan-in saja
  }
  return m;
}

/**
 * PPR sederhana (Personalized PageRank, 2 iterasi BFS + restart ke seed).
 * Reuse proximity yang sudah dihitung sebagai proxy bila iterasi penuh
 * mahal: ppr pada simpul = proximity ternormalisasi max proximity, seed
 * bervilai seedScore. Cukup murah dan konsisten dengan sinyal graph yang
 * sudah ada. Nilai di 0..1.
 */
function proximityAsPpr(
  proximity: Map<number, number>,
  seedScore: Map<number, number>
): Map<number, number> {
  const ppr = new Map<number, number>();
  let maxProx = 0;
  for (const v of proximity.values()) if (v > maxProx) maxProx = v;
  if (maxProx <= 0) maxProx = 1;
  const restart = 0.85; // faktor restart ke seed (1 - alpha)
  for (const [id, prox] of proximity) {
    const proxNorm = Math.min(1, prox / maxProx);
    const seedBoost = seedScore.get(id) ?? 0;
    // PPR proxy: mayoritas dari jarak graph, sedikit dari ke-seed-an langsung.
    ppr.set(id, Math.min(1, restart * proxNorm + (1 - restart) * seedBoost));
  }
  return ppr;
}

// Simbol non-seed yang hanya dekat di graph tak boleh naik berkat fan-in saja.
const HUB_DAMPING = 0.3;
export const HIGH_MIN_SCORE = 0.3;
const HIGH_RELATIVE = 0.75;
export const HIGH_MAX_FILES = 4;

export function isTestPath(p: string): boolean {
  const norm = p.replace(/\\/g, "/");
  return (
    norm.includes(".test.") ||
    norm.includes(".spec.") ||
    norm.includes("__tests__") ||
    /(^|\/)tests?\//.test(norm) ||
    (norm.split("/").pop() ?? "").startsWith("test_")
  );
}

export function isExplicitTestTask(task: string): boolean {
  return /\b(test|tests|testing|spec|specs|suite|mock|assert)\b/i.test(task);
}

/** Tier HIGH: skor mutlak ≥ 0.3 DAN ≥ 75% skor teratas, maks HIGH_MAX_FILES file. */
export function selectHigh(ranked: RankedSymbol[], allowTests = false): RankedSymbol[] {
  const top = ranked[0]?.score ?? 0;
  const above = ranked
    .filter((r) => r.score >= HIGH_MIN_SCORE && r.score >= top * HIGH_RELATIVE)
    .filter((r) => allowTests || !isTestPath(r.file));
  // `above` sudah terurut skor tertinggi (ranked terurut). Ambil top-K file
  // terbaik agar simbol di file yang sama tetap bersama, tapi file ke-5+
  // (meski lolos ambang) tak membengkak HIGH.
  const out: RankedSymbol[] = [];
  const files = new Set<string>();
  for (const r of above) {
    if (!files.has(r.file) && files.size >= HIGH_MAX_FILES) continue;
    files.add(r.file);
    out.push(r);
  }
  return out;
}

// SEED → EXPAND → RANK (PRD FR-04 / FR-05).
export interface RetrieveOptions {
  topN?: number;
  maxDepth?: number;
  /** Override bobot untuk tuning/benchmark ( Fase 6 ) tanpa menyentuh config.yml. */
  weights?: Partial<Pick<RetrievalConfig, "wSeed" | "wProximity" | "wCentrality" | "wRecency" | "wCochange" | "wPpr" | "wPr">>;
  /** File/folder yang dipilih agent sebagai titik awal (seed skor penuh). */
  anchors?: string[];
}

/** Simbol di file/folder anchor. Path dinormalisasi ke bentuk index (`a/b.ts`). */
export function anchorSeeds(db: DatabaseSync, anchors: string[]): { symbolId: number; bm25: number }[] {
  const out = new Map<number, number>();
  const stmt = db.prepare(
    `SELECT s.id FROM symbols s JOIN files f ON f.id = s.file_id
     WHERE (f.path = ? OR f.path LIKE ? ESCAPE '\\')`
  );
  for (const raw of anchors) {
    const a = raw.trim().replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
    if (!a) continue;
    const esc = a.replace(/[\\%_]/g, (c) => "\\" + c);
    for (const r of stmt.all(a, `${esc}/%`) as { id: number }[]) out.set(r.id, 1);
  }
  return [...out].map(([symbolId, bm25]) => ({ symbolId, bm25 }));
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
  if (opts?.anchors?.length) {
    const lexical = new Map(seeds.map((s) => [s.symbolId, s]));
    for (const a of anchorSeeds(db, opts.anchors)) lexical.set(a.symbolId, a);
    seeds.splice(0, seeds.length, ...lexical.values());
  }

  // CLOSED-LOOP LEARNING: Cek task terverifikasi terdahulu yang mirip
  const verifiedAnalogs = findVerifiedAnalogs(db, task);
  const verifiedFileWeights = new Map<string, number>();
  for (const va of verifiedAnalogs) {
    for (const f of va.files) {
      const cur = verifiedFileWeights.get(f) ?? 0;
      if (va.score > cur) verifiedFileWeights.set(f, va.score);
    }
  }

  if (verifiedFileWeights.size > 0) {
    const stmt = db.prepare(
      `SELECT s.id FROM symbols s JOIN files f ON f.id = s.file_id WHERE f.path = ?`
    );
    const seedMap = new Map(seeds.map((s) => [s.symbolId, s]));
    for (const [vf, weight] of verifiedFileWeights) {
      const symRows = stmt.all(vf) as { id: number }[];
      const boostBm25 = Math.min(1.0, 0.6 + weight * 0.4);
      for (const r of symRows) {
        const existing = seedMap.get(r.id);
        if (!existing || existing.bm25 < boostBm25) {
          seedMap.set(r.id, { symbolId: r.id, bm25: boostBm25 });
        }
      }
    }
    seeds.splice(0, seeds.length, ...seedMap.values());
  }
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

  // Centrality: 0.5*pr_norm + 0.5*fanin_norm (PageRank ternormalisasi max).
  // Sumber fan-in: cache tabel `fanin` (diisi scan). PageRank dari
  // `node_metrics` bila ada; bila tidak ada, pr_norm = fanin_norm sehingga
  // centrality identik dengan fanin murni (perilaku lama).
  const fanin = loadFanin(db);
  let maxFan = 1;
  for (const n of fanin.values()) {
    if (n > maxFan) maxFan = n;
  }
  const pagerank = loadPagerank(db);
  let maxPr = 0.000001;
  for (const v of pagerank.values()) if (v > maxPr) maxPr = v;
  const pprMap = proximityAsPpr(proximity, seedScore);

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
  const git = gitSignalsFor(db, repoRoot, [...seedFiles]);

  // RANK: gabungkan 5 sinyal.
  const meta = new Map<number, { name: string; type: string; file: string; signature: string; startLine: number; endLine: number }>();
  if (visited.size > 0) {
    // Dibelah per 900 id: `visited` pada repo besar bisa melampaui batas
    // variabel terikat SQLite → statement gagal total (bukan hasil kosong).
    const visitedIds = [...visited];
    for (let i = 0; i < visitedIds.length; i += SQL_VAR_CHUNK) {
      const c = visitedIds.slice(i, i + SQL_VAR_CHUNK);
      const ph = c.map(() => "?").join(",");
      for (const r of db
        .prepare(
          `SELECT s.id, s.name, s.type, s.signature, s.start_line AS startLine, s.end_line AS endLine, f.path AS file FROM symbols s
           JOIN files f ON f.id = s.file_id WHERE s.id IN (${ph})`
        )
        .all(...c) as { id: number; name: string; type: string; signature: string; startLine: number; endLine: number; file: string }[]) {
        meta.set(r.id, r);
      }
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
    const faninNorm = (fanin.get(id) ?? 0) / maxFan;
    // Tanpa node_metrics, pr_norm = faninNorm → centrality = faninNorm
    // (pertahankan perilaku lama). Bila ada PageRank, centrality digabung
    // 50/50 antara PR global dan fan-in lokal.
    const prNorm = pagerank.size > 0 ? (pagerank.get(id) ?? 0) / maxPr : faninNorm;
    const centrality =
      (0.5 * prNorm + 0.5 * faninNorm) * (seed > 0.05 ? 1 : HUB_DAMPING);
    const recency = git.recency.get(m.file) ?? 0;
    const cochange = git.cochange.get(m.file) ?? 0;
    const verifiedWeight = verifiedFileWeights.get(m.file) ?? 0;
    const ppr = pprMap.get(id) ?? 0;
    const pr = prNorm;
    const isTestTask = isExplicitTestTask(task);
    const isTest = isTestPath(m.file);
    let score =
      config.wSeed * seed +
      config.wProximity * Math.min(1, prox) +
      config.wCentrality * centrality +
      config.wRecency * recency +
      config.wCochange * cochange +
      (config.wPpr ?? 0) * ppr +
      (config.wPr ?? 0) * pr +
      (verifiedWeight > 0 ? verifiedWeight * 0.35 : 0);
    if (isTest && !isTestTask) {
      score *= 0.35;
    }
    const why: string[] = [];
    if (verifiedWeight > 0) why.push("verified");
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
      startLine: m.startLine,
      endLine: m.endLine,
      score,
      parts: {
        seed,
        proximity: Math.min(1, prox),
        centrality,
        recency,
        cochange,
        ppr,
        pr,
        verified: verifiedWeight,
      },
      reason: why.join("+") || "graph",
    });
  }
  ranked.sort((a, b) => b.score - a.score);
  // Fallback: bila hanya simpul file yang cocok (mis. package.json, skema) —
  // kembalikan file itu agar Protected/scope tetap terlihat.
  // Bila ranked tak kosong tapi ada file-seed kuat (task menyebut nama file,
  // mis. "package json") yang belum terwakili, sertakan maksimal 2 agar
  // file config tak hilang di balik simbol dengan skor proximity/centrality.
  const fileSeeds = seeds
    .map((s) => ({ id: s.symbolId, seed: s.bm25, m: meta.get(s.symbolId) }))
    .filter((s) => s.m && s.m.type === "file")
    .sort((a, b) => b.seed - a.seed)
    .slice(0, 5);
  if (ranked.length === 0 && skippedFiles > 0) {
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
  } else if (fileSeeds.length > 0) {
    const covered = new Set(ranked.map((r) => r.file));
    let added = 0;
    for (const f of fileSeeds) {
      if (added >= 2 || f.seed < 0.5 || covered.has(f.m!.file)) continue;
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
      covered.add(f.m!.file);
      added++;
    }
    ranked.sort((a, b) => b.score - a.score);
  }
  return {
    tokens,
    seeds: seeds.map((s) => s.symbolId),
    ranked: ranked.slice(0, config.topN),
    config,
    gitAvailable: git.available,
    verifiedAnalogs: verifiedAnalogs.length > 0 ? verifiedAnalogs : undefined,
  };
}
