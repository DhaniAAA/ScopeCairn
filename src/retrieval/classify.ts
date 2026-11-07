import { isProtected } from "../scope/protected.js";
import type { RankedSymbol } from "./retrieve.js";

// Klasifikasi SIMPLE vs COMPLEX (PRD FR-14): berdasarkan estimasi
// banyaknya perubahan kode pada file, dari hasil retrieval sebelum edit.
// COMPLEX bila SALAH SATU kriteria COMPLEX terpenuhi.

export interface Classification {
  complexity: "SIMPLE" | "COMPLEX";
  estimatedFiles: number;
  modules: string[];
  reasons: string[];
  highFanin: string[];
  protectedHits: string[];
  /** Estimasi LOC dari endLine-startLine simbol relevan (0 bila tak diketahui). */
  estimatedLoc: number;
}

const FANIN_THRESHOLD = 5;

/** Modul = 2 level direktori (mis. `src/retrieval`), bukan hanya top-dir. */
function moduleOf(file: string): string {
  const norm = file.replace(/\\/g, "/");
  const parts = norm.split("/").filter(Boolean);
  if (parts.length <= 1) return ".";
  if (parts.length === 2) return parts[0]!;
  return `${parts[0]}/${parts[1]}`;
}

export function classify(
  ranked: RankedSymbol[],
  faninOf: (id: number) => number,
  threshold = 0.15,
  protectedPatterns?: string[],
  clusterOf?: (id: number) => string | undefined
): Classification {
  const relevant = ranked.filter((r) => r.score >= threshold);
  const files = [...new Set(relevant.map((r) => r.file))];
  // Modul = 2-level dir + cluster (bila tersedia): dua file se-cluster dihitung
  // satu modul meski beda dir, agar komunitas Louvain yang kohesif tak
  // didakwa lintas-modul hanya karena perbedaan subdir kecil.
  const clusterByFile = new Map<string, string>();
  if (clusterOf) {
    for (const r of relevant) {
      const c = clusterOf(r.id);
      if (c && !clusterByFile.has(r.file)) clusterByFile.set(r.file, c);
    }
    // Bila file berbeda punya cluster label sama, pakai label itu sebagai
    // pengganti path modul agar modules.length tidak membengkak.
    for (const [f, c] of clusterByFile) clusterByFile.set(f, `cluster:${c}`);
  }
  const modules = [
    ...new Set(
      files.map((f) => {
        if (clusterByFile.has(f)) {
          // Hanya pakai cluster bila minimal 2 file relevan berbagi cluster
          // yang sama, atau file tak punya info path bermakna — bila cluster
          // tunggal, tetap pakai moduleOf agar modul tetap stabil.
          const same = files.filter(
            (x) => clusterByFile.get(x) === clusterByFile.get(f)
          ).length;
          if (same >= 2) return clusterByFile.get(f)!;
        }
        return moduleOf(f);
      })
    ),
  ];
  const reasons: string[] = [];
  // Fan-in hanya bermakna untuk simbol definisi; variable/noise regex dikecualikan.
  const DEFINITIONAL = new Set([
    "function",
    "class",
    "method",
    "component",
    "interface",
    "type",
  ]);
  const highFanin = relevant
    .filter((r) => DEFINITIONAL.has(r.type) && faninOf(r.id) >= FANIN_THRESHOLD)
    .map((r) => r.name);
  const protectedHits = files.filter((f) =>
    protectedPatterns ? isProtected(f, protectedPatterns) : isProtected(f)
  );

  let complexity: "SIMPLE" | "COMPLEX" = "SIMPLE";
  if (files.length >= 3) {
    complexity = "COMPLEX";
    reasons.push(`estimasi ${files.length} file (≥3)`);
  }
  if (modules.length > 1) {
    complexity = "COMPLEX";
    reasons.push(`lintas modul (${modules.join(", ")})`);
  }
  if (highFanin.length > 0) {
    complexity = "COMPLEX";
    reasons.push(`simbol dipakai banyak tempat: ${highFanin.slice(0, 3).join(", ")}`);
  }
  if (protectedHits.length > 0) {
    complexity = "COMPLEX";
    reasons.push(`menyentuh area sensitif: ${protectedHits.slice(0, 3).join(", ")}`);
  }
  if (complexity === "SIMPLE") reasons.push(`estimasi ${files.length} file, 1 modul`);

  // Estimasi LOC: jumlah baris pada simbol relevan (endLine-startLine+1).
  // Simbol tanpa info baris (0/undefined) diabaikan — 0 berarti tak diketahui.
  let estimatedLoc = 0;
  for (const r of relevant) {
    if (r.startLine && r.startLine > 0) {
      const end = r.endLine && r.endLine >= r.startLine ? r.endLine : r.startLine;
      estimatedLoc += end - r.startLine + 1;
    }
  }

  return {
    complexity,
    estimatedFiles: files.length,
    modules,
    reasons,
    highFanin,
    protectedHits,
    estimatedLoc,
  };
}
