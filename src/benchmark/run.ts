import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { retrieve, type RetrieveOptions } from "../retrieval/retrieve.js";
import { BENCHMARK_TASKS } from "./dataset.js";

export interface TaskScore {
  task: string;
  expected: string[];
  retrievedFiles: string[];
  highFiles: string[];
  hits: string[];
  recall: number;
  irrelevantRatio: number;
  baselineChars: number;
  optimizedChars: number;
  contextReduction: number;
}

export interface BenchmarkSummary {
  tasks: TaskScore[];
  avgRecall: number;
  avgIrrelevant: number;
  avgReduction: number;
  recallAtThreshold: number;
}

function fileChars(repoRoot: string, rel: string): number {
  try {
    return fs.readFileSync(path.join(repoRoot, rel), "utf8").length;
  } catch {
    return 0;
  }
}

// Baseline (§18.2): agent tanpa ScopeCairn membaca file penuh yang akhirnya
// relevan + ~2x eksplorasi buta (faktor konservatif dari alur §2:
// list→grep→read→grep→read ≈ 2x file relevan dibaca penuh).
// Optimized: excerpt per simbol top (rata-rata 1KB/simbol,上限 file penuh).
export function runBenchmark(
  db: DatabaseSync,
  repoRoot: string,
  opts?: RetrieveOptions
): BenchmarkSummary {
  const tasks: TaskScore[] = [];
  for (const t of BENCHMARK_TASKS) {
    const res = retrieve(db, repoRoot, t.task, opts);
    // Recall: seluruh konteks yang diterima agent (ambang hi+med ≥ 0.15).
    // Irrelevant: file HIGH (≥ 0.3) yang dibaca duluan; bila HIGH kosong,
    // pakai 3 file teratas sebagai proksi bacaan pertama.
    const files: string[] = [];
    const high: string[] = [];
    for (const r of res.ranked) {
      if (r.score >= 0.3 && !high.includes(r.file)) high.push(r.file);
      if (r.score < 0.15) break;
      if (!files.includes(r.file)) files.push(r.file);
      if (files.length >= 10) break;
    }
    const firstRead = high.length > 0 ? high : files.slice(0, 3);
    const hits = t.expected.filter((e) => files.includes(e));
    const recall = t.expected.length > 0 ? hits.length / t.expected.length : 1;
    const highHits = t.expected.filter((e) => firstRead.includes(e));
    const irrelevantRatio =
      firstRead.length > 0 ? (firstRead.length - highHits.length) / firstRead.length : 0;

    const baselineChars =
      t.expected.reduce((a, f) => a + fileChars(repoRoot, f), 0) * 2;
    // Optimized ≈ excerpt per simbol top (read symbol ±40 baris ≈ 1.2KB).
    const optimizedChars = Math.max(1, res.ranked.slice(0, 8).length * 1200);
    const contextReduction =
      baselineChars > 0 ? Math.max(0, 1 - optimizedChars / baselineChars) : 0;

    tasks.push({
      task: t.task,
      expected: t.expected,
      retrievedFiles: files,
      highFiles: firstRead,
      hits,
      recall,
      irrelevantRatio,
      baselineChars,
      optimizedChars,
      contextReduction,
    });
  }
  const avg = (xs: number[]): number =>
    xs.length > 0 ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
  return {
    tasks,
    avgRecall: avg(tasks.map((t) => t.recall)),
    avgIrrelevant: avg(tasks.map((t) => t.irrelevantRatio)),
    avgReduction: avg(tasks.map((t) => t.contextReduction)),
    recallAtThreshold: tasks.filter((t) => t.recall >= 0.5).length / tasks.length,
  };
}

export interface TuneResult {
  weights: { wSeed: number; wProximity: number; wCentrality: number };
  avgRecall: number;
  avgIrrelevant: number;
}

// Grid search bobot FR-05 (wRecency/wCochange tetap: repo ini bukan git repo).
export function tuneWeights(
  db: DatabaseSync,
  repoRoot: string
): { best: TuneResult; baseline: TuneResult; tried: number } {
  const base: TuneResult = {
    weights: { wSeed: 0.3, wProximity: 0.35, wCentrality: 0.15 },
    avgRecall: 0,
    avgIrrelevant: 0,
  };
  const baseSum = runBenchmark(db, repoRoot, { weights: base.weights });
  base.avgRecall = baseSum.avgRecall;
  base.avgIrrelevant = baseSum.avgIrrelevant;

  let best = base;
  let tried = 0;
  for (const wSeed of [0.2, 0.3, 0.4, 0.5]) {
    for (const wProximity of [0.25, 0.35, 0.45]) {
      for (const wCentrality of [0.1, 0.15, 0.2]) {
        tried++;
        const s = runBenchmark(db, repoRoot, {
          weights: { wSeed, wProximity, wCentrality },
        });
        const better =
          s.avgRecall > best.avgRecall ||
          (s.avgRecall === best.avgRecall && s.avgIrrelevant < best.avgIrrelevant);
        if (better) {
          best = {
            weights: { wSeed, wProximity, wCentrality },
            avgRecall: s.avgRecall,
            avgIrrelevant: s.avgIrrelevant,
          };
        }
      }
    }
  }
  return { best, baseline: base, tried };
}
