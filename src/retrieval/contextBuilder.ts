import type { DatabaseSync } from "node:sqlite";
import type { RetrievalResult, RankedSymbol } from "./retrieve.js";
import type { Classification } from "./classify.js";
import { loadProtectedPatterns, isProtected } from "../scope/protected.js";
import { computeScope, scopeBlock } from "../scope/scope.js";
import { guardBlock } from "../scope/guard.js";
import { coChangeSet, groupHistoryFiles, type HistoryAnalog } from "./history/search.js";
import { demoteHeadings, type ProjectRules } from "../scope/agentsmd.js";

// Context Builder (PRD FR-06): Markdown ringkas untuk agent.
// Prioritas §14: buang tak-relevan → dedup → level simbol → ringkas → source on-demand.

export type AgentMode = "NORMAL" | "FAST" | "SAFE" | "AUDIT";

/** Hotspot PageRank terstruktur (dipakai rendering markdown + envelope --json). */
export interface ContextHotspot {
  name: string;
  type: string;
  file: string;
  pagerank: number;
}

export interface BuiltContext {
  markdown: string;
  high: string[];
  medium: string[];
  tests: string[];
  dependencies: string[];
  hotspots: ContextHotspot[];
}

export interface HistoryBlock {
  analogs: HistoryAnalog[];
  /** Statistik diff per sha pendek (hanya bila --with-diff). */
  diffStats?: Map<string, string>;
}

export function buildContext(
  db: DatabaseSync,
  task: string,
  result: RetrievalResult,
  cls: Classification,
  opts?: { escalate?: boolean; repoRoot?: string; history?: HistoryBlock; withDiff?: boolean; projectRules?: ProjectRules | null; knowledge?: boolean }
): BuiltContext {
  const complex = cls.complexity === "COMPLEX" || opts?.escalate === true;

  if (!complex && !opts?.knowledge) {
    // §8.4 SIMPLE: pendek, tanpa ekspansi penuh. Mode --knowledge selalu lewat
    // cabang knowledge di bawah — task SIMPLE justru yang tak boleh kosong.
    const files: string[] = [];
    for (const r of result.ranked) {
      if (!files.includes(r.file)) files.push(r.file);
      if (files.length >= 3) break;
    }
    const cand =
      files.length > 0
        ? files.map((f) => `\`${f}\``).join(", ")
        : "pencarian langsung (tidak ada simbol cocok di index)";
    return {
      markdown:
        `# Task Context\n\n## Task\n${task}\n\n## Complexity\n` +
        `SIMPLE (${cls.reasons.join("; ")})\n\n` +
        `Task sederhana. Gunakan pencarian langsung. Kandidat: ${cand}\n`,
      high: [],
      medium: [],
      tests: [],
      dependencies: [],
      hotspots: [],
    };
  }

  const ranked = result.ranked;
  const hi = ranked.filter((r) => r.score >= 0.3).slice(0, 10);
  const med = ranked.filter((r) => r.score >= 0.15 && r.score < 0.3).slice(0, 10);
  const highFiles = [...new Set(hi.map((r) => r.file))];
  const medFiles = [...new Set(med.map((r) => r.file))].filter((f) => !highFiles.includes(f));

  // Dependencies: rantai IMPORTS/CALLS antar file HIGH (maks 10). Di mode
  // knowledge, seed jatuh ke MEDIUM saat tak ada HIGH (task SIMPLE) agar
  // seksi "Kenapa" tidak selalu kosong.
  const traceSeed = highFiles.length > 0 ? highFiles : opts?.knowledge ? medFiles : [];
  const deps: string[] = [];
  if (traceSeed.length > 0) {
    const ph = traceSeed.map(() => "?").join(",");
    try {
      const rows = db
        .prepare(
          `SELECT DISTINCT f1.path AS a, f2.path AS b
           FROM relationships r
           JOIN symbols s1 ON s1.id = r.source_id
           JOIN symbols s2 ON s2.id = r.target_id
           JOIN files f1 ON f1.id = s1.file_id
           JOIN files f2 ON f2.id = s2.file_id
           WHERE r.relationship_type IN ('IMPORTS','CALLS')
             AND f1.path IN (${ph}) AND f2.path IN (${ph}) AND f1.path != f2.path
           LIMIT 10`
        )
        .all(...traceSeed, ...traceSeed) as { a: string; b: string }[];
      for (const r of rows) deps.push(`${r.a} → ${r.b}`);
    } catch {
      // ignore
    }
  }

  // Related tests: edge TESTS ke file HIGH + 2-hop callers (graph, seperti
  // findAffectedTests) + file *.test.* di kandidat. Tanpa import dari
  // commands/testselect agar lapisan retrieval tetap bersih.
  // Arah edge: source = file test, target = file yang diuji (lihat linkTests).
  const isTestFileLike = (p: string): boolean =>
    p.includes(".test.") ||
    p.includes(".spec.") ||
    p.includes("__tests__") ||
    (p.split("/").pop() ?? "").startsWith("test_");
  const testSet = new Set<string>();
  if (highFiles.length > 0) {
    const ph = highFiles.map(() => "?").join(",");
    try {
      const rows = db
        .prepare(
          `SELECT DISTINCT f1.path AS t
           FROM relationships r
           JOIN symbols s1 ON s1.id = r.source_id
           JOIN symbols s2 ON s2.id = r.target_id
           JOIN files f1 ON f1.id = s1.file_id
           JOIN files f2 ON f2.id = s2.file_id
           WHERE r.relationship_type = 'TESTS' AND f2.path IN (${ph})`
        )
        .all(...highFiles) as { t: string }[];
      for (const r of rows) testSet.add(r.t);
    } catch {
      // ignore
    }
    // 2-hop: simbol HIGH -> callers (1-hop) -> callers-of-callers (2-hop).
    // Bila caller tinggal di file test, anggap test terkait.
    try {
      const symRows = db
        .prepare(
          `SELECT s.id AS id FROM symbols s
           JOIN files f ON f.id = s.file_id
           WHERE f.path IN (${ph}) LIMIT 50`
        )
        .all(...highFiles) as { id: number }[];
      const targetIds = symRows.map((r) => r.id);
      if (targetIds.length > 0) {
        const inClause = targetIds.map(() => "?").join(",");
        const callerRows = db
          .prepare(
            `SELECT DISTINCT s.file_id AS fid, f.path AS p
             FROM relationships r
             JOIN symbols s ON s.id = r.source_id
             JOIN files f ON f.id = s.file_id
             WHERE r.target_id IN (${inClause})`
          )
          .all(...targetIds) as { fid: number; p: string }[];
        const intermediateIds: number[] = [];
        for (const c of callerRows) {
          if (isTestFileLike(c.p)) testSet.add(c.p);
        }
        try {
          const idRows = db
            .prepare(`SELECT DISTINCT r.source_id AS id FROM relationships r WHERE r.target_id IN (${inClause}) LIMIT 100`)
            .all(...targetIds) as { id: number }[];
          intermediateIds.push(...idRows.map((r) => r.id));
        } catch {
          // ignore
        }
        if (intermediateIds.length > 0) {
          const interClause = intermediateIds.map(() => "?").join(",");
          const indirectRows = db
            .prepare(
              `SELECT DISTINCT f.path AS p
               FROM relationships r
               JOIN symbols s ON s.id = r.source_id
               JOIN files f ON f.id = s.file_id
               WHERE r.target_id IN (${interClause})`
            )
            .all(...intermediateIds) as { p: string }[];
          for (const r of indirectRows) {
            if (isTestFileLike(r.p)) testSet.add(r.p);
          }
        }
      }
    } catch {
      // ignore — fallback ke TESTS edge + nama file saja
    }
  }
  for (const r of ranked) {
    if (isTestFileLike(r.file)) testSet.add(r.file);
  }
  const tests = [...testSet].slice(0, 10);

  const symLine = (r: (typeof ranked)[number]): string =>
    `- ${r.name} (${r.type}) — \`${r.file}\` [${r.score.toFixed(2)} ${r.reason}]`;

  const hotspotLine = (h: ContextHotspot): string =>
    `- ${h.name} (${h.type}) — \`${h.file}\` [pr=${h.pagerank.toFixed(4)}]`;

  // Graphify Engine: naikkan peringkat kandidat dengan PageRank — simbol yang
  // paling kritis di arsitektur (God objects, hubs) tampil sebagai hotspot.
  let hotspots: ContextHotspot[] = [];
  let cycleWarn = "";
  try {
    const ids = ranked.slice(0, 20).map((r) => r.id);
    if (ids.length > 0) {
      const ph = ids.map(() => "?").join(",");
      const prRows = db
        .prepare(`SELECT node_id AS id, pagerank AS pr FROM node_metrics WHERE node_id IN (${ph})`)
        .all(...ids) as { id: number; pr: number }[];
      const pr = new Map(prRows.map((r) => [r.id, r.pr]));
      const boosted = ranked
        .slice(0, 20)
        .map((r) => ({ r, boost: r.score + (pr.get(r.id) ?? 0) * 2 }))
        .sort((a, b) => b.boost - a.boost)
        .slice(0, 5);
      hotspots = boosted.map((b) => ({
        name: b.r.name,
        type: b.r.type,
        file: b.r.file,
        pagerank: pr.get(b.r.id) ?? 0,
      }));
      // Peringatan siklus: kandidat yang terjerat circular dependency.
      const cycRows = db.prepare(`SELECT nodes_json AS js FROM cycles`).all() as { js: string }[];
      const inCycle = new Set<number>();
      for (const c of cycRows) {
        try {
          for (const n of JSON.parse(c.js) as number[]) inCycle.add(n);
        } catch {
          // ignore
        }
      }
      const trapped = ranked.slice(0, 10).filter((r) => inCycle.has(r.id));
      if (trapped.length > 0) {
        cycleWarn =
          `\n## Circular dependency warning\n` +
          trapped.slice(0, 5).map((r) => `- ${r.name} (\`${r.file}\`) is inside a dependency cycle`).join("\n") +
          `\n`;
      }
    }
  } catch {
    // tabel metrik/siklus belum ada — lewati tanpa gagal
  }

  // Task Scope nyata (FR-07): Required/Optional/Protected dari pola path.
  // Co-change riwayat hanya menambah Optional (tak pernah Required).
  const historyAnalogs = opts?.history?.analogs ?? [];
  const cochange = coChangeSet(historyAnalogs);
  const patterns = loadProtectedPatterns(opts?.repoRoot ?? ".");
  const historyOptional = cochange
    .map((c) => c.path)
    .filter((f) => !isProtected(f, patterns));
  const scope = computeScope(highFiles, medFiles, tests, patterns, historyOptional);

  // Bagian Analogi riwayat (disembunyikan bila tak ada analog lolos ambang).
  let historyBlock = "";
  if (historyAnalogs.length > 0) {
    const lines: string[] = [`## Analogi riwayat`, ``];
    for (const a of historyAnalogs) {
      const g = groupHistoryFiles(a.files);
      lines.push(`- \`${a.shortSha}\` ${a.date} — ${a.subject}`);
      if (g.source.length > 0) lines.push(`  source: ${g.source.join(", ")}`);
      if (g.test.length > 0) lines.push(`  test: ${g.test.join(", ")}`);
      if (g.config.length > 0) lines.push(`  config: ${g.config.join(", ")}`);
      if (g.docs.length > 0) lines.push(`  docs: ${g.docs.join(", ")}`);
      const stat = opts?.history?.diffStats?.get(a.shortSha);
      if (stat) lines.push(`  diff: ${stat}`);
    }
    if (cochange.length > 0) {
      lines.push(
        ``,
        `Co-change (ikut berubah di ≥2 analog): ` +
          cochange.map((c) => `${c.path} (${c.count}x)`).join(", ")
      );
    }
    lines.push(``);
    historyBlock = lines.join("\n") + "\n";
  }

  // DoD tambahan bila analog membawa test sementara Required belum punya test.
  const extraDoD: string[] = [];
  const requiredHasTest = scope.required.some((f) => isTestFileLike(f));
  const analogTestSha = historyAnalogs.find((a) => groupHistoryFiles(a.files).test.length > 0);
  if (analogTestSha && !requiredHasTest) {
    extraDoD.push(`ubah atau tambah test, seperti pada \`${analogTestSha.shortSha}\``);
  }

  // Project Rules dari AGENTS.md proyek (disembunyikan bila tak ada file).
  // Ditempatkan di awal agar konvensi terbaca sebelum daftar file.
  // Heading di dalam AGENTS.md diturunkan (demoted) agar tetap bersarang di bawah
  // ## Project Rules dan tidak memecah delimiter pemangkasan token.
  let rulesBlock = "";
  const rules = opts?.projectRules;
  if (rules && rules.content) {
    rulesBlock =
      `## Project Rules\n\n` +
      `> Sumber: \`${rules.path}\` — konvensi proyek, berlaku untuk task ini.\n` +
      (rules.truncated ? `> (dipotong ke anggaran — baca file langsung untuk lengkapnya)\n` : ``) +
      `\n${demoteHeadings(rules.content)}\n\n`;
  }

  // F1 --knowledge: explain mode untuk knowledge agent (read-only).
  // Sembunyikan Scope Required/Optional + Guard coding, ganti dengan
  // Ringkasan + Kenapa + Cara pakai. Tanpa flag = output lama identik.
  if (opts?.knowledge) {
    // Task SIMPLE sering tak punya skor >=0.3 — jatuh ke MEDIUM agar Ringkasan
    // dan Cara pakai tetap berisi (mode knowledge tak boleh kosong).
    const kFiles = highFiles.length > 0 ? highFiles : medFiles;
    const kSyms = hi.length > 0 ? hi : med;
    const alsoMed = highFiles.length > 0 && medFiles.length > 0;
    const mdKnowledge =
      `# Task Context (Knowledge)\n\n## Task\n${task}\n\n` +
      `## Complexity\n${cls.complexity} (${cls.reasons.join("; ")})\n\n` +
      rulesBlock +
      `## Ringkasan\n` +
      `File relevan: ${kFiles.slice(0, 5).join(", ") || "-"}${alsoMed ? ` (lihat juga: ${medFiles.slice(0, 5).join(", ")})` : ""}\n` +
      `Simbol kunci: ${kSyms.slice(0, 5).map((r) => `\`${r.name}\``).join(", ") || "-"}\n\n` +
      `## Kenapa (impor/call antar file relevan)\n${deps.map((d) => `- ${d}`).join("\n") || "-"}\n\n` +
      (hotspots.length > 0
        ? `## Hotspot arsitektur\n${hotspots.map(hotspotLine).join("\n")}\n\n`
        : ``) +
      `## Cara pakai\n${kSyms.slice(0, 8).map(symLine).join("\n") || "-"}\n\n` +
      `## Related Tests\n${tests.map((t) => `- ${t}`).join("\n") || "-"}\n\n` +
      historyBlock +
      cycleWarn;
    return {
      markdown: mdKnowledge,
      high: highFiles,
      medium: medFiles,
      tests,
      dependencies: deps,
      hotspots,
    };
  }

  const md =
    `# Task Context\n\n## Task\n${task}\n\n` +
    `## Complexity\n${cls.complexity} (${cls.reasons.join("; ")})\n\n` +
    rulesBlock +
    `## Relevant Files\n### HIGH\n${highFiles.map((f) => `- ${f}`).join("\n") || "-"}\n` +
    `### MEDIUM\n${medFiles.map((f) => `- ${f}`).join("\n") || "-"}\n\n` +
    `## Key Symbols\n${hi.slice(0, 8).map(symLine).join("\n") || "-"}\n\n` +
    (hotspots.length > 0
      ? `## Critical hotspots (PageRank)\n${hotspots.map(hotspotLine).join("\n")}\n\n`
      : ``) +
    `## Dependencies\n${deps.map((d) => `- ${d}`).join("\n") || "-"}\n\n` +
    `## Related Tests\n${tests.map((t) => `- ${t}`).join("\n") || "-"}\n\n` +
    historyBlock +
    cycleWarn +
    scopeBlock(scope) +
    `\n` +
    guardBlock(extraDoD.length > 0 ? extraDoD : undefined);

  return { markdown: md, high: highFiles, medium: medFiles, tests, dependencies: deps, hotspots };
}

/** Routing cost-aware (dipakai cmdContext): SIMPLE + ≤1 file → FAST implisit,
 *  kecuali mode knowledge — analog "kenapa" + simbol penuh justru dibutuhkan. */
export function resolveEffectiveMode(
  mode: AgentMode,
  cls: Classification,
  knowledge?: boolean
): AgentMode {
  return mode === "NORMAL" && cls.complexity === "SIMPLE" && cls.estimatedFiles <= 1 && !knowledge
    ? "FAST"
    : mode;
}

/** F2 --json: envelope kanonik untuk knowledge/RAG agent. Semua jalur —
 *  kena ranking maupun kosong — memakai builder ini agar key-nya identik.
 *  Catatan: `high` kosong dengan `medium` berisi = normal untuk task SIMPLE. */
export interface ContextPayload {
  task: string;
  complexity: "SIMPLE" | "COMPLEX";
  mode: AgentMode;
  knowledge: boolean;
  empty: boolean;
  reason: "no_index" | "no_symbols" | null;
  high: string[];
  medium: string[];
  tests: string[];
  dependencies: string[];
  symbols: Array<{ name: string; type: string; file: string; score: number; reason: string }>;
  hotspots: ContextHotspot[];
  analogs: Array<{ sha: string; shortSha: string; date: string; subject: string; score: number }>;
}

export function buildContextPayload(input: {
  task: string;
  cls: Classification;
  escalate?: boolean;
  mode: AgentMode;
  knowledge?: boolean;
  built?: BuiltContext | null;
  ranked?: RankedSymbol[];
  analogs?: HistoryAnalog[];
  empty?: boolean;
  reason?: "no_index" | "no_symbols";
}): ContextPayload {
  const built = input.built ?? null;
  const payload: ContextPayload = {
    task: input.task,
    complexity: input.escalate ? "COMPLEX" : input.cls.complexity,
    mode: input.mode,
    knowledge: Boolean(input.knowledge),
    empty: Boolean(input.empty),
    reason: input.reason ?? null,
    high: built?.high ?? [],
    medium: built?.medium ?? [],
    tests: built?.tests ?? [],
    dependencies: built?.dependencies ?? [],
    symbols: (input.ranked ?? []).slice(0, 20).map((r) => ({
      name: r.name,
      type: r.type,
      file: r.file,
      score: r.score,
      reason: r.reason,
    })),
    hotspots: built?.hotspots ?? [],
    analogs: (input.analogs ?? []).map((a) => ({
      sha: a.sha,
      shortSha: a.shortSha,
      date: a.date,
      subject: a.subject,
      score: a.score,
    })),
  };
  return payload;
}
