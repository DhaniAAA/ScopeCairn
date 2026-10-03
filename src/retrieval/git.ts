import { execFileSync } from "node:child_process";

// Sinyal git untuk ranking (PRD FR-05, FR-11): Recency + Co-change.
// Gagal lembut: bukan repo git / git tak ada → sinyal nol.

export interface GitSignals {
  /** path -> 0..1, 1 = commit paling baru */
  recency: Map<string, number>;
  /** path -> 0..1, seberapa sering berubah bersama file seed */
  cochange: Map<string, number>;
  available: boolean;
}

function runGit(repoRoot: string, args: string[]): string | null {
  try {
    return execFileSync("git", args, {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: 8000,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return null;
  }
}

export function gitSignals(
  repoRoot: string,
  seedFiles: string[],
  maxCommits = 120
): GitSignals {
  const empty: GitSignals = { recency: new Map(), cochange: new Map(), available: false };
  const log = runGit(repoRoot, [
    "log",
    `--max-count=${maxCommits}`,
    "--name-only",
    "--format=COMMIT:%h",
  ]);
  if (!log) return empty;

  const commits: string[][] = [];
  let cur: string[] = [];
  for (const line of log.split("\n")) {
    const t = line.trim();
    if (t.startsWith("COMMIT:")) {
      if (cur.length > 0) commits.push(cur);
      cur = [];
    } else if (t) {
      cur.push(t);
    }
  }
  if (cur.length > 0) commits.push(cur);
  if (commits.length === 0) return empty;

  const recency = new Map<string, number>();
  commits.forEach((files, i) => {
    const score = 1 - i / commits.length; // commit terbaru = ~1
    for (const f of files) {
      if (!recency.has(f)) recency.set(f, score);
    }
  });

  // Co-change: untuk tiap commit yang menyentuh seed, hitung partner.
  const seedSet = new Set(seedFiles);
  const partner = new Map<string, number>();
  let seedCommits = 0;
  for (const files of commits) {
    if (files.some((f) => seedSet.has(f))) {
      seedCommits++;
      for (const f of files) {
        if (!seedSet.has(f)) partner.set(f, (partner.get(f) ?? 0) + 1);
      }
    }
  }
  const cochange = new Map<string, number>();
  if (seedCommits > 0) {
    for (const [f, n] of partner) cochange.set(f, n / seedCommits);
  }

  return { recency, cochange, available: true };
}
