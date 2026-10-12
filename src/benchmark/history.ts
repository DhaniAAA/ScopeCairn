// Benchmark leave-one-out Analogi Riwayat (spec §9): untuk tiap commit,
// sembunyikan commit itu + yang lebih baru, jadikan subject sebagai task,
// ukur recall/precision file yang dipromosikan via co-change set.

import type { DatabaseSync } from "node:sqlite";
import { coChangeSet, historySearch } from "../retrieval/history/search.js";
import { logError } from "../log.js";

export interface HistoryBenchmark {
  commits: number;
  avgRecall: number;
  avgPrecision: number;
  promotedTotal: number;
}

export function runHistoryBenchmark(
  db: DatabaseSync,
  maxCommits = 200,
  nowSec?: number
): HistoryBenchmark {
  const empty: HistoryBenchmark = { commits: 0, avgRecall: 0, avgPrecision: 0, promotedTotal: 0 };
  try {
    const rows = db
      .prepare(`SELECT sha, ts, subject FROM commits ORDER BY ts DESC LIMIT ?`)
      .all(maxCommits) as { sha: string; ts: number; subject: string }[];
    if (rows.length === 0) return empty;
    let recallSum = 0;
    let precSum = 0;
    let counted = 0;
    let promotedTotal = 0;
    const getFiles = db.prepare(`SELECT path FROM commit_files WHERE sha = ?`);
    for (const target of rows) {
      const expected = new Set(
        (getFiles.all(target.sha) as { path: string }[]).map((r) => r.path)
      );
      if (expected.size === 0) continue;
      const analogs = historySearch(db, target.subject, {
        limit: 3,
        asOfTs: target.ts - 1,
        excludeShas: [target.sha],
        nowSec,
      });
      const promoted = new Set(coChangeSet(analogs).map((c) => c.path));
      if (promoted.size === 0) continue;
      let hit = 0;
      for (const p of promoted) if (expected.has(p)) hit++;
      recallSum += hit / expected.size;
      precSum += hit / promoted.size;
      promotedTotal += promoted.size;
      counted++;
    }
    if (counted === 0) return empty;
    return { commits: counted, avgRecall: recallSum / counted, avgPrecision: precSum / counted, promotedTotal };
  } catch (err) {
    logError("history", err);
    return empty;
  }
}
