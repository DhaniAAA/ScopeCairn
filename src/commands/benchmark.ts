import { openDb } from "../db.js";
import { refreshIndex } from "../refresh.js";
import { skipRefresh } from "./opts.js";
import { runBenchmark, tuneWeights } from "../benchmark/run.js";
import { runHistoryBenchmark } from "../benchmark/history.js";
import { benchmarkReport } from "../benchmark/report.js";
import { gitSignalsFor } from "../retrieval/git.js";

// Benchmark & kalibrasi (PRD §18). Tanpa LLM: recall, irrelevant ratio,
// estimasi context reduction, dan grid search bobot FR-05.
export async function cmdBenchmark(
  repoRoot: string,
  opts: { tune?: boolean; noRefresh?: boolean; refresh?: boolean } = {}
): Promise<void> {
  if (!skipRefresh(opts)) await refreshIndex(repoRoot);
  const db = openDb(repoRoot);
  try {
    const fileCount = (
      db.prepare(`SELECT COUNT(*) AS n FROM files`).get() as { n: number }
    ).n;
    if (fileCount === 0) {
      console.log("Index kosong. Jalankan `scopecairn scan` dulu.");
      return;
    }
    const git = gitSignalsFor(db, repoRoot, []);
    const summary = runBenchmark(db, repoRoot);
    const tune = opts.tune ? tuneWeights(db, repoRoot) : null;
    console.log(benchmarkReport(summary, tune, git.available));
    // Leave-one-out riwayat: recall/precision promosi co-change (aditif).
    try {
      const hist = runHistoryBenchmark(db);
      if (hist.commits > 0) {
        console.log(
          `\nHistory leave-one-out: ${hist.commits} commits, ` +
            `recall ${hist.avgRecall.toFixed(2)}, precision ${hist.avgPrecision.toFixed(2)} ` +
            `(${hist.promotedTotal} file dipromosikan)`
        );
      } else {
        console.log(`\nHistory leave-one-out: riwayat kosong (jalankan \`scopecairn scan\` di repo git).`);
      }
    } catch {
      // best-effort
    }
  } finally {
    db.close();
  }
}
