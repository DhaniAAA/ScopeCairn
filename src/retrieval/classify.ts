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
}

const FANIN_THRESHOLD = 5;

function moduleOf(file: string): string {
  const i = file.indexOf("/");
  return i === -1 ? "." : file.slice(0, i);
}

export function classify(
  ranked: RankedSymbol[],
  faninOf: (id: number) => number,
  threshold = 0.15,
  protectedPatterns?: string[]
): Classification {
  const relevant = ranked.filter((r) => r.score >= threshold);
  const files = [...new Set(relevant.map((r) => r.file))];
  const modules = [...new Set(files.map(moduleOf))];
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

  return {
    complexity,
    estimatedFiles: files.length,
    modules,
    reasons,
    highFanin,
    protectedHits,
  };
}
