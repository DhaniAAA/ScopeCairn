import { execFileSync } from "node:child_process";
import type { DatabaseSync } from "node:sqlite";

// Sinyal git untuk ranking (PRD FR-05, FR-11): Recency + Co-change.
// Gagal lembut: bukan repo git / git tak ada → sinyal nol.
//
// Dua sumber, DB-first:
//   1. Tabel `commits` + `commit_files` — riwayat yang SUDAH diindeks saat
//      scan. Membaca dari sini menghapus satu subprocess `git log` + parse
//      log dari setiap pemanggilan retrieve() (context/verify), yang di repo
//      besar dengan sejarah dalam adalah salah satu biaya terbesar.
//   2. `git log` langsung — fallback bila DB belum punya riwayat (mis. repo
//      belum di-scan, atau tabel riwayat tak ada di DB lama).
//
// Catatan semantik: indeks DB memakai `git log --no-merges` dan melewati
// lockfile/generated (isHistorySkipped) serta commit >40 file. Untuk sinyal
// co-change itu justru lebih baik — file generated tak lagi mengotori
// partner. Merge commit di jalur `git log` sendiri tak menampilkan file,
// jadi selisihnya hanya pada penyebut skala recency.

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

/** Perhitungan recency + co-change dari daftar file-per-commit (terbaru dulu). */
function computeSignals(
  commits: string[][],
  seedFiles: string[]
): { recency: Map<string, number>; cochange: Map<string, number> } {
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
  return { recency, cochange };
}

/**
 * Sinyal git dari indeks riwayat di DB. Mengembalikan `available: false`
 * bila DB belum punya riwayat (repo belum di-scan / DB lama).
 */
export function gitSignalsFromDb(
  db: DatabaseSync,
  seedFiles: string[],
  maxCommits = 120
): GitSignals {
  const empty: GitSignals = { recency: new Map(), cochange: new Map(), available: false };
  let rows: { sha: string }[];
  try {
    rows = db
      .prepare(`SELECT sha FROM commits ORDER BY ts DESC LIMIT ?`)
      .all(maxCommits) as { sha: string }[];
  } catch {
    return empty;
  }
  if (rows.length === 0) return empty;

  const bySha = new Map<string, string[]>();
  const shas = rows.map((r) => r.sha);
  const CHUNK = 900; // di bawah batas variabel terikat SQLite
  try {
    for (let i = 0; i < shas.length; i += CHUNK) {
      const c = shas.slice(i, i + CHUNK);
      const ph = c.map(() => "?").join(",");
      for (const r of db
        .prepare(`SELECT sha, path FROM commit_files WHERE sha IN (${ph})`)
        .all(...c) as { sha: string; path: string }[]) {
        const arr = bySha.get(r.sha);
        if (arr) arr.push(r.path);
        else bySha.set(r.sha, [r.path]);
      }
    }
  } catch {
    return empty;
  }

  const commits = shas.map((s) => bySha.get(s) ?? []);
  const { recency, cochange } = computeSignals(commits, seedFiles);
  return { recency, cochange, available: true };
}

/** Sinyal git via `git log` langsung. Fallback saat indeks DB kosong. */
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

  const { recency, cochange } = computeSignals(commits, seedFiles);
  return { recency, cochange, available: true };
}

/**
 * Entry point untuk ranking: baca dari DB dulu (murah, tanpa subprocess),
 * jatuh ke `git log` bila indeks riwayat belum ada.
 */
export function gitSignalsFor(
  db: DatabaseSync | null,
  repoRoot: string,
  seedFiles: string[],
  maxCommits = 120
): GitSignals {
  if (db) {
    const fromDb = gitSignalsFromDb(db, seedFiles, maxCommits);
    if (fromDb.available) return fromDb;
  }
  return gitSignals(repoRoot, seedFiles, maxCommits);
}
