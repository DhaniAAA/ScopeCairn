import type { DatabaseSync } from "node:sqlite";
import type { RetrievalResult } from "./retrieve.js";
import type { Classification } from "./classify.js";
import { loadProtectedPatterns } from "../scope/protected.js";
import { computeScope, scopeBlock } from "../scope/scope.js";
import { guardBlock } from "../scope/guard.js";

// Context Builder (PRD FR-06): Markdown ringkas untuk agent.
// Prioritas §14: buang tak-relevan → dedup → level simbol → ringkas → source on-demand.

export interface BuiltContext {
  markdown: string;
  high: string[];
  medium: string[];
  tests: string[];
  dependencies: string[];
}

export function buildContext(
  db: DatabaseSync,
  task: string,
  result: RetrievalResult,
  cls: Classification,
  opts?: { escalate?: boolean; repoRoot?: string }
): BuiltContext {
  const complex = cls.complexity === "COMPLEX" || opts?.escalate === true;

  if (!complex) {
    // §8.4 SIMPLE: pendek, tanpa ekspansi penuh.
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
    };
  }

  const ranked = result.ranked;
  const hi = ranked.filter((r) => r.score >= 0.3).slice(0, 10);
  const med = ranked.filter((r) => r.score >= 0.15 && r.score < 0.3).slice(0, 10);
  const highFiles = [...new Set(hi.map((r) => r.file))];
  const medFiles = [...new Set(med.map((r) => r.file))].filter((f) => !highFiles.includes(f));

  // Dependencies: rantai IMPORTS antar file HIGH (maks 10).
  const deps: string[] = [];
  if (highFiles.length > 0) {
    const ph = highFiles.map(() => "?").join(",");
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
        .all(...highFiles, ...highFiles) as { a: string; b: string }[];
      for (const r of rows) deps.push(`${r.a} → ${r.b}`);
    } catch {
      // ignore
    }
  }

  // Related tests: edge TESTS ke file HIGH + file *.test.* di kandidat.
  const testSet = new Set<string>();
  if (highFiles.length > 0) {
    const ph = highFiles.map(() => "?").join(",");
    try {
      const rows = db
        .prepare(
          `SELECT DISTINCT f2.path AS t
           FROM relationships r
           JOIN symbols s1 ON s1.id = r.source_id
           JOIN symbols s2 ON s2.id = r.target_id
           JOIN files f1 ON f1.id = s1.file_id
           JOIN files f2 ON f2.id = s2.file_id
           WHERE r.relationship_type = 'TESTS'
             AND (f1.path IN (${ph}) OR f2.path IN (${ph}))`
        )
        .all(...highFiles, ...highFiles) as { t: string }[];
      for (const r of rows) testSet.add(r.t);
    } catch {
      // ignore
    }
  }
  for (const r of ranked) {
    if (/(test|spec)/i.test(r.file)) testSet.add(r.file);
  }
  const tests = [...testSet].slice(0, 10);

  const symLine = (r: (typeof ranked)[number]): string =>
    `- ${r.name} (${r.type}) — \`${r.file}\` [${r.score.toFixed(2)} ${r.reason}]`;

  // Graphify Engine: naikkan peringkat kandidat dengan PageRank — simbol yang
  // paling kritis di arsitektur (God objects, hubs) tampil sebagai hotspot.
  let hotspots: string[] = [];
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
      hotspots = boosted.map(
        (b) => `- ${b.r.name} (${b.r.type}) — \`${b.r.file}\` [pr=${(pr.get(b.r.id) ?? 0).toFixed(4)}]`
      );
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
  const scope = computeScope(
    highFiles,
    medFiles,
    tests,
    loadProtectedPatterns(opts?.repoRoot ?? ".")
  );

  const md =
    `# Task Context\n\n## Task\n${task}\n\n` +
    `## Complexity\n${cls.complexity} (${cls.reasons.join("; ")})\n\n` +
    `## Relevant Files\n### HIGH\n${highFiles.map((f) => `- ${f}`).join("\n") || "-"}\n` +
    `### MEDIUM\n${medFiles.map((f) => `- ${f}`).join("\n") || "-"}\n\n` +
    `## Key Symbols\n${hi.slice(0, 8).map(symLine).join("\n") || "-"}\n\n` +
    (hotspots.length > 0
      ? `## Critical hotspots (PageRank)\n${hotspots.join("\n")}\n\n`
      : ``) +
    `## Dependencies\n${deps.map((d) => `- ${d}`).join("\n") || "-"}\n\n` +
    `## Related Tests\n${tests.map((t) => `- ${t}`).join("\n") || "-"}\n\n` +
    cycleWarn +
    scopeBlock(scope) +
    `\n` +
    guardBlock();

  return { markdown: md, high: highFiles, medium: medFiles, tests, dependencies: deps };
}
