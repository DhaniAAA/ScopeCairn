// Perintah history: retrieval analog commit mandiri (tanpa graph).
// Best-effort: repo tanpa git / index kosong → pesan ramah, exit 0.

import { execFileSync } from "node:child_process";
import { openDb } from "../db.js";
import { logInvocation } from "../invocations.js";
import { refreshIndex } from "../refresh.js";
import { skipRefresh } from "./opts.js";
import { retrieve } from "../retrieval/retrieve.js";
import {
  coChangeSet,
  groupHistoryFiles,
  historySearch,
  type HistoryAnalog,
} from "../retrieval/history/search.js";

export interface HistoryPayload {
  task: string;
  empty: boolean;
  reason: "no_index" | "no_analogs" | null;
  analogs: HistoryAnalog[];
  coChange: { path: string; count: number }[];
}

/** Envelope --json dengan bentuk SELALU sama (termasuk saat kosong) agar
 *  konsumen machine (knowledge agent) bisa parse tanpa cabang teks. */
export function buildHistoryPayload(
  task: string,
  analogs: HistoryAnalog[] = [],
  reason?: "no_index" | "no_analogs"
): HistoryPayload {
  return {
    task,
    empty: analogs.length === 0,
    reason: reason ?? null,
    analogs,
    coChange: coChangeSet(analogs),
  };
}

export interface HistoryOptions {
  limit?: number;
  json?: boolean;
  noRefresh?: boolean;
  withDiff?: boolean;
}

function diffStat(repoRoot: string, sha: string): string | null {
  try {
    const out = execFileSync("git", ["show", "--stat", "--oneline", sha], {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: 8000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const lines = out.split("\n").filter(Boolean).slice(0, 12).join(" | ");
    return lines.slice(0, 500);
  } catch {
    return null;
  }
}

export async function cmdHistory(
  repoRoot: string,
  task: string,
  opts: HistoryOptions = {}
): Promise<void> {
  // Commander memetakan --no-refresh ke { refresh: false }; terima dua bentuk.
  if (!skipRefresh(opts)) {
    try {
      await refreshIndex(repoRoot);
    } catch {
      // best-effort
    }
  }
  const db = openDb(repoRoot);
  try {
    logInvocation(db, "history");
    const fileCount = (
      db.prepare(`SELECT COUNT(*) AS n FROM files`).get() as { n: number }
    ).n;
    if (fileCount === 0) {
      if (opts.json) {
        console.log(JSON.stringify(buildHistoryPayload(task, [], "no_index"), null, 2));
        return;
      }
      console.log("Index kosong. Jalankan `scopecairn scan` dulu.");
      return;
    }
    // Seed overlap dari retrieval graph (file HIGH/MED).
    let seedFiles: string[] = [];
    try {
      const res = retrieve(db, repoRoot, task, { topN: 20, maxDepth: 2 });
      seedFiles = [...new Set(res.ranked.filter((r) => r.score >= 0.15).map((r) => r.file))].slice(0, 20);
    } catch {
      // abaikan — overlap nol
    }
    const limit = Math.max(1, Math.min(10, opts.limit ?? 3));
    const analogs = historySearch(db, task, { seedFiles, limit });
    if (analogs.length === 0) {
      if (opts.json) {
        console.log(JSON.stringify(buildHistoryPayload(task, [], "no_analogs"), null, 2));
        return;
      }
      console.log("Tidak ada analog riwayat yang melewati ambang.");
      return;
    }
    if (opts.json) {
      console.log(JSON.stringify(buildHistoryPayload(task, analogs), null, 2));
      return;
    }
    console.log(`# Analogi riwayat: ${task}\n`);
    for (const a of analogs) {
      const g = groupHistoryFiles(a.files);
      console.log(`- \`${a.shortSha}\` ${a.date} — ${a.subject} [${a.score.toFixed(3)}]`);
      if (g.source.length > 0) console.log(`  source: ${g.source.join(", ")}`);
      if (g.test.length > 0) console.log(`  test: ${g.test.join(", ")}`);
      if (g.config.length > 0) console.log(`  config: ${g.config.join(", ")}`);
      if (g.docs.length > 0) console.log(`  docs: ${g.docs.join(", ")}`);
      if (opts.withDiff) {
        const stat = diffStat(repoRoot, a.sha);
        if (stat) console.log(`  diff: ${stat}`);
      }
    }
    const co = coChangeSet(analogs);
    if (co.length > 0) {
      console.log(`\nCo-change: ${co.map((c) => `${c.path} (${c.count}x)`).join(", ")}`);
    }
  } finally {
    db.close();
  }
}
