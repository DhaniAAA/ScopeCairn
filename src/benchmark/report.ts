import type { BenchmarkSummary, TuneResult } from "./run.js";

// Laporan benchmark (§18.2): angka + ambang Fase 6 + protokol manual
// untuk metrik yang butuh agent run (success, tool call, waktu).
export function benchmarkReport(
  summary: BenchmarkSummary,
  tune: { best: TuneResult; baseline: TuneResult; tried: number } | null,
  gitAvailable: boolean
): string {
  const pct = (x: number): string => `${(x * 100).toFixed(0)}%`;
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
    `| Irrelevant file ratio (bacaan pertama HIGH) | ${pct(summary.avgIrrelevant)} | < 20% | ${summary.avgIrrelevant < 0.2 ? "✓" : "✗"} |`,
    `| Context reduction (estimasi) | ${pct(summary.avgReduction)} | ≥ 30% | ${summary.avgReduction >= 0.3 ? "✓" : "✗"} |`,
    ``,
    `## Per task`,
    ``,
    `| Task | Recall | Irrelevant | Ditemukan | Bacaan pertama |`,
    `|---|---|---|---|---|`,
  ];
  for (const t of summary.tasks) {
    lines.push(
      `| ${t.task} | ${pct(t.recall)} | ${pct(t.irrelevantRatio)} | ${t.hits.join(", ") || "-"} | ${t.highFiles.join(", ") || "-"} |`
    );
  }
  if (tune) {
    const b = tune.best;
    lines.push(
      ``,
      `## Kalibrasi bobot (${tune.tried} kombinasi)`,
      ``,
      `Baseline: seed=${tune.baseline.weights.wSeed} prox=${tune.baseline.weights.wProximity} cent=${tune.baseline.weights.wCentrality} → recall ${pct(tune.baseline.avgRecall)}, irrelevant ${pct(tune.baseline.avgIrrelevant)}`,
      `Terbaik: seed=${b.weights.wSeed} prox=${b.weights.wProximity} cent=${b.weights.wCentrality} → recall ${pct(b.avgRecall)}, irrelevant ${pct(b.avgIrrelevant)}`,
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
