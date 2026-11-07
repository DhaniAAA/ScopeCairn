import type { BenchmarkSummary, TuneResult } from "./run.js";

// Laporan benchmark (§18.2): angka + ambang Fase 6 + protokol manual
// untuk metrik yang butuh agent run (success, tool call, waktu).
export function benchmarkReport(
  summary: BenchmarkSummary,
  tune: { best: TuneResult; baseline: TuneResult; tried: number } | null,
  gitAvailable: boolean
): string {
  const pct = (x: number): string => `${(x * 100).toFixed(0)}%`;
  const frac = (x: number): string => x.toFixed(3);
  const escCell = (s: string): string => s.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
  const lines: string[] = [
    `# ScopeCairn Benchmark`,
    ``,
    `Dataset: ${summary.tasks.length} task (repo sendiri, ground truth file relevan).`,
    `Git signals: ${gitAvailable ? "aktif" : "nonaktif (bukan repo git — wRecency/wCochange = 0)"}.`,
    ``,
    `## Ringkasan otomatis`,
    ``,
    `| Metrik | Hasil | Ambang §18 | Status |`,
    `|---|---|---|---|`,
    `| Retrieval recall (rata-rata, konteks penuh) | ${pct(summary.avgRecall)} | ditetapkan awal ≥ 70% | ${summary.avgRecall >= 0.7 ? "✓" : "✗"} |`,
    `| Task recall ≥ 50% | ${pct(summary.recallAtThreshold)} | — | — |`,
    `| nDCG (rata-rata) | ${frac(summary.avgNdcg)} | — | — |`,
    `| MRR (rata-rata) | ${frac(summary.avgMrr)} | — | — |`,
    `| Irrelevant file ratio (bacaan pertama HIGH) | ${pct(summary.avgIrrelevant)} | < 20% | ${summary.avgIrrelevant < 0.2 ? "✓" : "✗"} |`,
    `| Context reduction (estimasi) | ${pct(summary.avgReduction)} | ≥ 30% | ${summary.avgReduction >= 0.3 ? "✓" : "✗"} |`,
    ``,
    `## Per task`,
    ``,
    `| Task | Recall | nDCG | MRR | Irrelevant | Ditemukan | Bacaan pertama |`,
    `|---|---|---|---|---|---|---|`,
  ];
  for (const t of summary.tasks) {
    lines.push(
      `| ${escCell(t.task)} | ${pct(t.recall)} | ${frac(t.ndcg)} | ${frac(t.mrr)} | ${pct(t.irrelevantRatio)} | ${escCell(t.hits.join(", ") || "-")} | ${escCell(t.highFiles.join(", ") || "-")} |`
    );
  }
  if (tune) {
    const best = tune.best;
    lines.push(
      ``,
      `## Kalibrasi bobot (${tune.tried} kombinasi)`,
      ``,
      `Baseline: seed=${tune.baseline.weights.wSeed} prox=${tune.baseline.weights.wProximity} cent=${tune.baseline.weights.wCentrality} → recall ${pct(tune.baseline.avgRecall)}, irrelevant ${pct(tune.baseline.avgIrrelevant)}, nDCG ${frac(tune.baseline.avgNdcg)}, MRR ${frac(tune.baseline.avgMrr)}`,
      `Terbaik: seed=${best.weights.wSeed} prox=${best.weights.wProximity} cent=${best.weights.wCentrality} → recall ${pct(best.avgRecall)}, irrelevant ${pct(best.avgIrrelevant)}, nDCG ${frac(best.avgNdcg)}, MRR ${frac(best.avgMrr)}`,
      tune.best.avgRecall - tune.baseline.avgRecall > 0.05
        ? `Rekomendasi: terapkan ke \`.scopecairn/config.yml\` (gain > 5%).`
        : `Rekomendasi: pertahankan default (gain ≤ 5% — hindari overfit ke 12 task).`
    );
  }
  lines.push(
    ``,
    `## Protokol manual (butuh agent run)`,
    ``,
    `Otomatisasi di atas tak mengukur: token input riil, tool call, waktu,`,
    `task success, compliance rate. Protokol: 10 task nyata × 2 kondisi`,
    `(agent saja vs agent + \`scopecairn context\`), catat token/tool/file/success`,
    `per §18.2. Compliance = task dengan pemanggilan tercatat di \`invocations\`.`
  );
  return lines.join("\n");
}
