import { openDb } from "../db.js";
import { logInvocation } from "../invocations.js";
import { refreshIndex } from "../refresh.js";
import { retrieve } from "../retrieval/retrieve.js";
import { classify, type Classification } from "../retrieval/classify.js";
import {
  buildContext,
  buildContextPayload,
  resolveEffectiveMode,
  type AgentMode,
} from "../retrieval/contextBuilder.js";
import { cmdOrientasi, looksLikeRepoPath } from "./orientasi.js";
import { loadDecisions } from "../decisions.js";
import { loadProtectedPatterns } from "../scope/protected.js";
import { persistScope } from "../scope/taskScope.js";
import { changedFilesVsHead } from "../retrieval/gitChanged.js";
import { skipRefresh } from "./opts.js";

export type ContextFormat = "brief" | "table" | "tree" | "mermaid" | "markdown";

export interface ContextOptions {
  escalate?: boolean;
  noRefresh?: boolean;
  /** Commander mengisi `--no-refresh` → `refresh: false`. Lihat `skipRefresh`. */
  refresh?: boolean;
  mode?: AgentMode;
  maxTokens?: number;
  noHistory?: boolean;
  withDiff?: boolean;
  noRules?: boolean;
  withRules?: boolean;
  withGuard?: boolean;
  withBodies?: boolean;
  bodies?: boolean;
  knowledge?: boolean;
  json?: boolean;
  anchor?: string[];
  explain?: boolean;
  format?: string;
}

/** Seksi markdown yang boleh dibuang saat --max-tokens — harus PERSIS sama
 *  dengan heading `## …` yang dirender contextBuilder (drift = prune bisu). */
export const PRUNE_SECTIONS = [
  "Analogi task terverifikasi",
  "Analogi riwayat",
  "Critical hotspots",
  "Hotspot arsitektur",
  "Circular dependency warning",
  "Dependencies",
  "Kenapa (impor/call antar file relevan)",
  "Cara pakai",
  "Related Tests",
  "Project Rules",
  "Ringkasan",
] as const;

/** Klasifikasi sintetis untuk jalur tanpa kandidat (index kosong / tanpa seed). */
function emptyClassification(reason: string): Classification {
  return {
    complexity: "SIMPLE",
    estimatedFiles: 0,
    modules: [],
    reasons: [reason],
    highFanin: [],
    protectedHits: [],
    estimatedLoc: 0,
  };
}

/** Tabel breakdown skor per simbol untuk `--explain` (reuse parts yang ada). */
function explainTable(result: { ranked: { name: string; file: string; score: number; parts: { seed: number; proximity: number; centrality: number; recency: number; cochange: number; ppr?: number; pr?: number; verified?: number } }[]; config: { wSeed: number; wProximity: number; wCentrality: number; wRecency: number; wCochange: number; wPpr?: number; wPr?: number } }): string {
  const c = result.config;
  const wppr = c.wPpr ?? 0;
  const wpr = c.wPr ?? 0;
  const rows = result.ranked.slice(0, 20).map((r) => {
    const p = r.parts;
    const contribs: Array<[string, number]> = [
      ["seed", c.wSeed * p.seed],
      ["prox", c.wProximity * p.proximity],
      ["cent", c.wCentrality * p.centrality],
      ["recency", c.wRecency * p.recency],
      ["cochange", c.wCochange * p.cochange],
      ["ppr", wppr * (p.ppr ?? 0)],
      ["pr", wpr * (p.pr ?? 0)],
      ["verified", (p.verified ?? 0) * 0.35],
    ];
    const breakdown = contribs
      .filter(([, v]) => v !== 0)
      .map(([k, v]) => `${k}=${v.toFixed(3)}`)
      .join(" ");
    return `${r.name} | ${r.file} | score=${r.score.toFixed(3)} | ${breakdown || "-"}`;
  });
  const header =
    `Score breakdown (wSeed=${c.wSeed} wProx=${c.wProximity} wCent=${c.wCentrality} wRecency=${c.wRecency} wCochange=${c.wCochange} wPpr=${wppr} wPr=${wpr}):\n` +
    `symbol | file | score | contributions\n`;
  return `\n\n## Score explain (--explain)\n\n${header}${rows.join("\n")}\n`;
}

/**
 * Fase 4.1 --format: render alternatif atas `result.ranked` (tanpa memanggil
 * contextBuilder markdown). brief = 1 baris per simbol (path + simbol + skor),
 * table = markdown table dari data yang sama, tree = grup folder,
 * mermaid = graph TD sederhana dari relasi antar simbol teratas.
 */
type RankedLite = { id: number; name: string; type: string; file: string; score: number };

function formatBrief(task: string, ranked: RankedLite[]): string {
  const lines = ranked.slice(0, 20).map(
    (r) => `${r.file} — ${r.name} (${r.type}) [${r.score.toFixed(3)}]`
  );
  return `# Context (brief) — ${task}\n\n${lines.join("\n")}\n`;
}

function formatTable(task: string, ranked: RankedLite[]): string {
  const rows = ranked
    .slice(0, 20)
    .map((r) => `| \`${r.file}\` | \`${r.name}\` | ${r.type} | ${r.score.toFixed(3)} |`);
  const head = `| File | Symbol | Type | Score |\n|---|---|---|---:|\n`;
  return `# Context (table) — ${task}\n\n${head}${rows.join("\n")}\n`;
}

function formatTree(task: string, ranked: RankedLite[]): string {
  const byDir = new Map<string, RankedLite[]>();
  for (const r of ranked.slice(0, 20)) {
    const dir = r.file.includes("/") ? r.file.slice(0, r.file.lastIndexOf("/")) : ".";
    const list = byDir.get(dir) ?? [];
    list.push(r);
    byDir.set(dir, list);
  }
  const lines: string[] = [`# Context (tree) — ${task}`, ``];
  for (const [dir, items] of [...byDir.entries()].sort((a, b) =>
    a[0].localeCompare(b[0])
  )) {
    lines.push(`${dir}/`);
    for (const r of items) {
      const base = dir === "." ? r.file : r.file.slice(dir.length + 1);
      lines.push(`  ${base} — ${r.name} (${r.type}) [${r.score.toFixed(3)}]`);
    }
  }
  return lines.join("\n") + "\n";
}

function formatMermaid(
  task: string,
  ranked: RankedLite[],
  db: { prepare: (sql: string) => { all: (...args: unknown[]) => unknown[] } }
): string {
  const top = ranked.slice(0, 30);
  const safe = (s: string): string =>
    s.replace(/["#<>`[\]|]/g, "").replace(/\s+/g, " ").slice(0, 60);
  const lines = ["```mermaid", "graph TD"];
  lines.push(`    %% Context: ${safe(task)}`);
  top.forEach((r, i) => {
    lines.push(`    n${i}["${safe(r.name)} [${safe(r.file)}]"]`);
  });
  // Edge call path sederhana: relasi antar simbol teratas (bukan indeks penuh).
  try {
    const idx = new Map(top.map((r, i) => [r.id, i]));
    if (top.length > 1) {
      const ph = top.map(() => "?").join(",");
      const rows = db
        .prepare(
          `SELECT source_id AS s, target_id AS t, relationship_type AS rel FROM relationships WHERE source_id IN (${ph}) AND target_id IN (${ph}) LIMIT 60`
        )
        .all(...top.map((r) => r.id), ...top.map((r) => r.id)) as {
        s: number;
        t: number;
        rel: string;
      }[];
      for (const e of rows) {
        const a = idx.get(e.s);
        const b = idx.get(e.t);
        if (a === undefined || b === undefined || a === b) continue;
        const rel = e.rel.replace(/[^A-Za-z0-9_]/g, "_").slice(0, 24) || "REL";
        lines.push(`    n${a} -->|${rel}| n${b}`);
      }
    }
  } catch {
    // relasi tak tersedia — node saja tetap valid untuk mermaid
  }
  lines.push("```");
  return lines.join("\n") + "\n";
}

/** Render --format; mengembalikan null untuk format tak dikenal. */
export function renderContextFormat(
  format: string,
  task: string,
  ranked: RankedLite[],
  db: { prepare: (sql: string) => { all: (...args: unknown[]) => unknown[] } }
): string | null {
  switch (format.toLowerCase()) {
    case "brief":
      return formatBrief(task, ranked);
    case "table":
      return formatTable(task, ranked);
    case "tree":
      return formatTree(task, ranked);
    case "mermaid":
      return formatMermaid(task, ranked, db);
    default:
      return null;
  }
}

// Entry point utama agent (PRD §8.4): satu perintah, ScopeCairn yang
// memutuskan seberapa banyak dikembalikan (SIMPLE ringkas / COMPLEX penuh).
export async function cmdContext(
  repoRoot: string,
  task: string,
  opts: ContextOptions = {}
): Promise<void> {
  if (!skipRefresh(opts)) {
    const { stats, bulk } = await refreshIndex(repoRoot);
    if (bulk) {
      const note =
        `> Note: ${stats.inserted + stats.updated} file berubah ` +
        `(mis. git pull/ganti branch). Konteks tetap dibuat; ` +
        `jalankan \`scopecairn scan\` bila hasil terasa usang.\n`;
      // --json: stdout harus tetap satu envelope utuh → catatan ke stderr.
      (opts.json ? console.error : console.log)(note);
    }
  }

  const db = openDb(repoRoot);
  try {
    /** Envelope kosong — jalur tanpa kandidat memakai bentuk key yang sama. */
    const printEmptyEnvelope = (reason: "no_index" | "no_symbols", why: string): void => {
      const clsEmpty = emptyClassification(why);
      console.log(
        JSON.stringify(
          buildContextPayload({
            task,
            cls: clsEmpty,
            mode: resolveEffectiveMode(opts.mode ?? "NORMAL", clsEmpty, opts.knowledge),
            knowledge: opts.knowledge,
            empty: true,
            reason,
          }),
          null,
          2
        )
      );
    };
    const fileCount = (
      db.prepare(`SELECT COUNT(*) AS n FROM files`).get() as { n: number }
    ).n;
    if (fileCount === 0) {
      if (opts.json) {
        printEmptyEnvelope("no_index", "index kosong");
        return;
      }
      console.log("Index kosong. Jalankan `scopecairn scan` dulu.");
      return;
    }

    // Task berupa path (`./`, `src/db.ts`, ...) = minta orientasi:
    // deterministik, tanpa ranking. Baru ke retrieval bila bukan path.
    // (--json selalu lewat retrieval agar stdout tetap satu envelope JSON.)
    if (!opts.json && looksLikeRepoPath(db, repoRoot, task)) {
      logInvocation(db, "context");
      cmdOrientasi(repoRoot, task);
      return;
    }

    const result = retrieve(db, repoRoot, task, { anchors: opts.anchor });
    if (result.ranked.length === 0) {
      // Selalu aman dipanggil (prinsip 6): tanpa seed pun beri arahan SIMPLE,
      // bukan jalan buntu — simpan scope kosong agar verify mengenali task ini.
      const t = db
        .prepare(`INSERT INTO tasks(description, complexity) VALUES (?, ?)`)
        .run(task, "SIMPLE");
      const taskId = Number(t.lastInsertRowid);
      persistScope(db, taskId, { required: [], optional: [], protected: [] });
      logInvocation(db, "context", taskId);
      if (opts.json) {
        printEmptyEnvelope("no_symbols", "tidak ada simbol cocok di index");
        return;
      }
      const title = opts.knowledge ? `# Task Context (Knowledge)` : `# Task Context`;
      console.log(
        `${title}\n\n## Task\n${task}\n\n## Complexity\n` +
          `SIMPLE (tidak ada simbol cocok di index)\n\n` +
          `Task sederhana. Gunakan pencarian langsung. ` +
          `Bila istilah domain tak cocok dengan nama kode, tambah alias di ` +
          `\`.scopecairn/glossary.yml\`.\n`
      );
      return;
    }

    const faninOf = (id: number): number => {
      const r = db
        .prepare(`SELECT COUNT(*) AS n FROM relationships WHERE target_id = ?`)
        .get(id) as { n: number };
      return r.n;
    };
    // Cluster lookup (opsional — tabel `clusters` dari Graphify Engine).
    const clusterCache = new Map<number, string | undefined>();
    const clusterOf = (id: number): string | undefined => {
      if (clusterCache.has(id)) return clusterCache.get(id);
      let name: string | undefined;
      try {
        const r = db
          .prepare(`SELECT cluster_name AS cn, cluster_id AS cid FROM clusters WHERE node_id = ?`)
          .get(id) as { cn: string | null; cid: number } | undefined;
        if (r) name = r.cn ?? String(r.cid);
      } catch {
        name = undefined;
      }
      clusterCache.set(id, name);
      return name;
    };
    const cls = classify(result.ranked, faninOf, 0.15, loadProtectedPatterns(repoRoot), clusterOf);

    // Persist untuk compliance/recall Fase 6.
    const t = db
      .prepare(`INSERT INTO tasks(description, complexity) VALUES (?, ?)`)
      .run(task, opts.escalate ? "COMPLEX" : cls.complexity);
    const taskId = Number(t.lastInsertRowid);
    const insCtx = db.prepare(
      `INSERT INTO task_context(task_id, symbol_id, score, reason) VALUES (?, ?, ?, ?)`
    );
    for (const r of result.ranked.slice(0, 20)) {
      insCtx.run(taskId, r.id, r.score, r.reason);
    }
    logInvocation(db, "context", taskId);

    const mode = opts.mode ?? "NORMAL";
    // Cost-aware routing: konteks kecil → FAST implisit (hindari eskalasi
    // boros), kecuali mode knowledge yang justru butuh analog + simbol penuh.
    const effectiveMode = resolveEffectiveMode(mode, cls, Boolean(opts.knowledge));
    const escalate =
      opts.escalate === true || effectiveMode === "SAFE" || effectiveMode === "AUDIT";

    // FAST = konteks paling ramping: ranking dipotong, anotasi ekstra dilewati.
    if (effectiveMode === "FAST") {
      result.ranked = result.ranked.slice(0, 8);
    }

    const changed = changedFilesVsHead(repoRoot);
    if (changed.length > 0) {
      const note =
        `> Working tree: ${changed.length} file berubah vs HEAD (${changed
          .slice(0, 5)
          .join(", ")}${changed.length > 5 ? ", ..." : ""}).\n`;
      // --json: stdout harus tetap satu envelope utuh → catatan ke stderr.
      (opts.json ? console.error : console.log)(note);
    }

    const decisions = loadDecisions(repoRoot);

    // Analogi riwayat: aktif default pada COMPLEX, dilewati bila --no-history
    // atau mode FAST. Gagal lembut (repo tanpa git) → seksi disembunyikan.
    // (Commander memetakan --no-history ke { history: false }; terima dua bentuk.)
    const skipHistory =
      opts.noHistory === true || (opts as { history?: boolean }).history === false;
    let historyAnalogs: import("../retrieval/history/search.js").HistoryAnalog[] = [];
    const diffStats = new Map<string, string>();
    if (!skipHistory && effectiveMode !== "FAST") {
      try {
        const { historySearch } = await import("../retrieval/history/search.js");
        const seedFiles = [...new Set(result.ranked.filter((r) => r.score >= 0.15).map((r) => r.file))].slice(0, 20);
        historyAnalogs = historySearch(db, task, { seedFiles, limit: 3 });
        if (opts.withDiff) {
          const { execFileSync } = await import("node:child_process");
          for (const a of historyAnalogs) {
            try {
              const out = execFileSync("git", ["show", "--stat", "--oneline", a.sha], {
                cwd: repoRoot,
                encoding: "utf8",
                timeout: 8000,
                stdio: ["ignore", "pipe", "ignore"],
              });
              diffStats.set(a.shortSha, out.split("\n").filter(Boolean).slice(0, 12).join(" | ").slice(0, 500));
            } catch {
              // abaikan per analog
            }
          }
        }
      } catch {
        historyAnalogs = [];
      }
    }

    // Default: lewati injeksi ulang AGENTS.md (sudah ada di system prompt IDE).
    // Aktifkan hanya bila --with-rules diberikan secara eksplisit.
    const includeRules =
      opts.withRules === true &&
      opts.noRules !== true &&
      (opts as { rules?: boolean }).rules !== false;
    let projectRules: import("../scope/agentsmd.js").ProjectRules | null = null;
    if (includeRules) {
      try {
        const { loadProjectRules } = await import("../scope/agentsmd.js");
        projectRules = loadProjectRules(repoRoot);
      } catch {
        projectRules = null;
      }
    }

    const built = buildContext(db, task, result, cls, {
      escalate,
      repoRoot,
      history: historyAnalogs.length > 0 ? { analogs: historyAnalogs, diffStats } : undefined,
      projectRules,
      knowledge: opts.knowledge,
      withGuard: opts.withGuard,
      withBodies: opts.bodies === false ? false : opts.withBodies === true ? true : undefined,
    });

    // Simpan scope yang dirender ke agent. `verify --task` lalu membandingkan
    // perubahan terhadap scope YANG BENAR-BENAR terlihat agent — bukan hasil
    // hitung ulang yang bisa berbeda (co-change riwayat, --escalate, SIMPLE).
    try {
      persistScope(db, taskId, built.scope);
    } catch {
      // persistensi scope bersifat opsional — jangan gagalkan context
    }
    // F2 --json: envelope machine-readable untuk RAG/knowledge agent.
    // Default markdown tetap agar konsumen lama tidak pecah.
    if (opts.json) {
      const payload = buildContextPayload({
        task,
        cls,
        escalate,
        mode: effectiveMode,
        knowledge: opts.knowledge,
        built,
        ranked: result.ranked,
        analogs: historyAnalogs,
      });
      console.log(JSON.stringify(payload, null, 2));
      return;
    }
    // Fase 4.1 --format: brief|table|tree|mermaid (default markdown).
    // --json menang atas --format; --explain tetap menempel di akhir.
    const fmt = (opts.format ?? "markdown").toLowerCase();
    if (fmt !== "markdown") {
      const rendered = renderContextFormat(
        fmt,
        task,
        result.ranked,
        db as unknown as {
          prepare: (sql: string) => { all: (...args: unknown[]) => unknown[] };
        }
      );
      if (rendered === null) {
        console.log(
          `Format tak dikenal "${opts.format}". Pilih: brief, table, tree, mermaid (default markdown).`
        );
        process.exitCode = 1;
        return;
      }
      let formatted = rendered;
      if (opts.explain) formatted += explainTable(result);
      const maxTokensFmt = opts.maxTokens;
      if (
        maxTokensFmt &&
        maxTokensFmt > 0 &&
        Math.ceil(formatted.length / 4) > maxTokensFmt
      ) {
        formatted =
          formatted.slice(0, maxTokensFmt * 4) +
          `\n\n## Note\nOutput dipangkas agar muat --max-tokens ${maxTokensFmt} (≈ ${maxTokensFmt * 4} char).\n`;
      }
      console.log(formatted);
      return;
    }
    let out = built.markdown;
    if (effectiveMode !== "NORMAL") {
      out += `\n\n## Mode\n${effectiveMode}\n`;
    }
    if (decisions) {
      out += `\n\n## Keputusan Arsitektur (.scopecairn/decisions.md)\n${decisions}\n`;
    }
    if (opts.explain) {
      out += explainTable(result);
    }
    const maxTokens = opts.maxTokens;
    if (maxTokens && maxTokens > 0 && Math.ceil(out.length / 4) > maxTokens) {
      const parts = out.split(/\n(?=## )/);
      for (const sec of PRUNE_SECTIONS) {
        if (Math.ceil(parts.join("\n").length / 4) <= maxTokens) break;
        const i = parts.findIndex((p) => p.startsWith(`## ${sec}`));
        if (i >= 0) parts.splice(i, 1);
      }
      out = parts.join("\n");
      if (Math.ceil(out.length / 4) > maxTokens) out = out.slice(0, maxTokens * 4);
      out += `\n\n## Note\nOutput dipangkas agar muat --max-tokens ${maxTokens} (≈ ${maxTokens * 4} char).\n`;
    }
    console.log(out);
  } finally {
    db.close();
  }
}
