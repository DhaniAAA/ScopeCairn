// Retrieval analog commit untuk Analogi Riwayat.
// Skor akhir = bm25_norm × recency(half-life 180 hari) × size_penalty × (1+overlap).
// Deterministik: ORDER BY score DESC, ts DESC, sha ASC. Tanpa throw.

import type { DatabaseSync } from "node:sqlite";
import { tokenizeTask } from "../tokenize.js";
import { commitTokens } from "./index.js";
import { logError } from "../../log.js";

export const HISTORY_HALF_LIFE_DAYS = 180;
export const HISTORY_MIN_SCORE = 0.05;
/** Cermin HISTORY_MAX_FILES_PER_COMMIT di extractor (anti commit raksasa). */
export const HISTORY_MAX_FILES = 40;
const BM25_LIMIT = 20;

export interface HistoryAnalog {
  sha: string;
  shortSha: string;
  ts: number;
  date: string;
  subject: string;
  files: string[];
  score: number;
}

export interface HistorySearchOptions {
  /** Himpunan file seed dari retrieval graph (untuk overlap Jaccard). */
  seedFiles?: string[];
  limit?: number;
  /** Sembunyikan commit dengan ts > asOfTs (anti-bocor benchmark). */
  asOfTs?: number;
  /** Sha yang disembunyikan (commit target leave-one-out). */
  excludeShas?: string[];
  halfLifeDays?: number;
  minScore?: number;
  /** "Sekarang" dalam detik epoch (untuk determinisme uji). */
  nowSec?: number;
}

export function recencyScore(ts: number, nowSec: number, halfLifeDays: number): number {
  if (ts <= 0) return 0.5;
  const ageDays = Math.max(0, (nowSec - ts) / 86400);
  return Math.pow(0.5, ageDays / Math.max(1, halfLifeDays));
}

export function sizePenalty(nFiles: number): number {
  return 1 / Math.log(2 + Math.max(0, nFiles));
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

/** Ikuti rantai rename lama→baru (maks 5 hop) ke path terkini. */
export function resolveCurrentPath(db: DatabaseSync, path: string): string {
  let cur = path;
  try {
    const stmt = db.prepare(`SELECT path FROM commit_files WHERE old_path = ? ORDER BY rowid DESC LIMIT 1`);
    for (let i = 0; i < 5; i++) {
      const row = stmt.get(cur) as { path: string } | undefined;
      if (!row || row.path === cur) break;
      cur = row.path;
    }
  } catch {
    // abaikan
  }
  return cur;
}

interface Candidate {
  sha: string;
  bm25norm: number;
}

/** BM25 via FTS5; fallback overlap token manual bila FTS tak tersedia. */
function candidates(
  db: DatabaseSync,
  tokens: string[],
  asOfTs?: number,
  excludeShas?: string[]
): Candidate[] {
  const excluded = new Set(excludeShas ?? []);
  if (tokens.length === 0) return [];
  const q = tokens.map((t) => `"${t.replace(/"/g, "")}"`).join(" OR ");
  try {
    const rows = db
      .prepare(
        `SELECT sha, bm25(commit_fts) AS rank FROM commit_fts
         WHERE commit_fts MATCH ? ORDER BY rank LIMIT ${BM25_LIMIT}`
      )
      .all(q) as { sha: string; rank: number }[];
    if (rows.length === 0) return [];
    const filt = rows.filter((r) => !excluded.has(r.sha));
    if (filt.length === 0) return [];
    const worst = Math.min(...filt.map((r) => r.rank));
    const range = Math.max(1e-9, 0 - worst + 1);
    void asOfTs;
    return filt.map((r) => ({
      sha: r.sha,
      bm25norm: Math.max(0, Math.min(1, (0 - r.rank + 0.5) / range)),
    }));
  } catch (err) {
    logError("history", err);
  }
  // Fallback ~30 baris: overlap token atas subject+paths.
  try {
    let rows = db.prepare(`SELECT sha, subject, ts FROM commits`).all() as {
      sha: string;
      subject: string;
      ts: number;
    }[];
    if (asOfTs !== undefined) rows = rows.filter((r) => r.ts <= asOfTs);
    rows = rows.filter((r) => !excluded.has(r.sha));
    const tset = new Set(tokens);
    const scored = rows.map((r) => {
      let paths: string[] = [];
      try {
        paths = (db.prepare(`SELECT path FROM commit_files WHERE sha = ?`).all(r.sha) as { path: string }[]).map((x) => x.path);
      } catch {
        // abaikan
      }
      const doc = new Set(commitTokens(r.subject, "", paths));
      let hit = 0;
      for (const t of tset) if (doc.has(t)) hit++;
      return { sha: r.sha, bm25norm: tset.size === 0 ? 0 : hit / tset.size };
    }).filter((r) => r.bm25norm > 0);
    scored.sort((a, b) => b.bm25norm - a.bm25norm || (a.sha < b.sha ? -1 : 1));
    return scored.slice(0, BM25_LIMIT);
  } catch (err) {
    logError("history", err);
    return [];
  }
}

export function historySearch(
  db: DatabaseSync,
  task: string,
  opts: HistorySearchOptions = {}
): HistoryAnalog[] {
  const seedFiles = new Set(opts.seedFiles ?? []);
  const limit = Math.max(1, Math.min(10, opts.limit ?? 3));
  const halfLife = opts.halfLifeDays ?? HISTORY_HALF_LIFE_DAYS;
  const minScore = opts.minScore ?? HISTORY_MIN_SCORE;
  const nowSec = opts.nowSec ?? Math.floor(Date.now() / 1000);
  const tokens = tokenizeTask(task);
  if (tokens.length === 0) return [];
  let cands: Candidate[];
  try {
    cands = candidates(db, tokens, opts.asOfTs, opts.excludeShas);
  } catch (err) {
    logError("history", err);
    return [];
  }
  if (cands.length === 0) return [];
  const out: (HistoryAnalog & { sortTs: number })[] = [];
  try {
    const getCommit = db.prepare(`SELECT ts, subject FROM commits WHERE sha = ?`);
    const getFiles = db.prepare(`SELECT path FROM commit_files WHERE sha = ?`);
    const fileExists = db.prepare(`SELECT 1 AS ok FROM files WHERE path = ? LIMIT 1`);
    for (const c of cands) {
      const commit = getCommit.get(c.sha) as { ts: number; subject: string } | undefined;
      if (!commit) continue;
      if (opts.asOfTs !== undefined && commit.ts > opts.asOfTs) continue;
      const rawFiles = (getFiles.all(c.sha) as { path: string }[]).map((r) => r.path);
      // Commit raksasa (>40 file) tak pernah jadi analog — cermin aturan indexing.
      if (rawFiles.length > HISTORY_MAX_FILES) continue;
      // Petakan rename ke path terkini, buang yang sudah tak ada.
      const live: string[] = [];
      for (const p of rawFiles) {
        const cur = resolveCurrentPath(db, p);
        try {
          const hit = fileExists.get(cur) as { ok: number } | undefined;
          if (hit) {
            if (!live.includes(cur)) live.push(cur);
          }
        } catch {
          // abaikan
        }
      }
      if (live.length === 0) continue;
      const rec = recencyScore(commit.ts, nowSec, halfLife);
      const pen = sizePenalty(rawFiles.length);
      const ov = jaccard(new Set(live), seedFiles);
      const score = c.bm25norm * rec * pen * (1 + ov);
      if (score < minScore) continue;
      const d = new Date(commit.ts * 1000);
      out.push({
        sha: c.sha,
        shortSha: c.sha.slice(0, 7),
        ts: commit.ts,
        date: Number.isNaN(d.getTime()) ? "-" : d.toISOString().slice(0, 10),
        subject: commit.subject,
        files: [...live].sort(),
        score,
        sortTs: commit.ts,
      });
    }
  } catch (err) {
    logError("history", err);
    return [];
  }
  out.sort((a, b) => b.score - a.score || b.sortTs - a.sortTs || (a.sha < b.sha ? -1 : a.sha > b.sha ? 1 : 0));
  return out.slice(0, limit).map(({ sortTs: _s, ...rest }) => rest);
}

/** Co-change set: file di ≥2 analog dan masih ada (sudah live). */
export function coChangeSet(analogs: HistoryAnalog[]): { path: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const a of analogs) {
    for (const f of new Set(a.files)) counts.set(f, (counts.get(f) ?? 0) + 1);
  }
  return [...counts.entries()]
    .filter(([, n]) => n >= 2)
    .map(([path, count]) => ({ path, count }))
    .sort((a, b) => b.count - a.count || (a.path < b.path ? -1 : 1));
}

export function groupHistoryFiles(files: string[]): { source: string[]; test: string[]; config: string[]; docs: string[] } {
  const source: string[] = [];
  const test: string[] = [];
  const config: string[] = [];
  const docs: string[] = [];
  for (const f of files) {
    const base = f.split("/").pop() ?? f;
    const lower = f.toLowerCase();
    if (
      f.includes(".test.") || f.includes(".spec.") || f.includes("__tests__") ||
      base.startsWith("test_") || base.endsWith("_test.py") || lower.startsWith("tests/")
    ) {
      test.push(f);
    } else if (
      /\.(json|ya?ml|toml|ini|cfg)$/.test(lower) ||
      ["package.json", "dockerfile", "makefile"].includes(base.toLowerCase())
    ) {
      config.push(f);
    } else if (/\.mdx?$/.test(lower) || lower.startsWith("docs/")) {
      docs.push(f);
    } else {
      source.push(f);
    }
  }
  return { source, test, config, docs };
}

/**
 * Benchmark leave-one-out: untuk tiap commit target, sembunyikan commit itu
 * dan semua yang lebih baru (asOfTs = ts-1), jadikan subject sebagai task,
 * ukur file commit yang muncul di co-change/promosi Optional.
 */
export function leaveOneOut(
  db: DatabaseSync,
  shas: string[],
  opts: { seedFilesOf?: (sha: string) => string[]; limit?: number; nowSec?: number } = {}
): { sha: string; subject: string; recalled: string[]; expected: string[]; recall: number }[] {
  const out: { sha: string; subject: string; recalled: string[]; expected: string[]; recall: number }[] = [];
  try {
    const getCommit = db.prepare(`SELECT ts, subject FROM commits WHERE sha = ?`);
    const getFiles = db.prepare(`SELECT path FROM commit_files WHERE sha = ?`);
    for (const sha of shas) {
      const commit = getCommit.get(sha) as { ts: number; subject: string } | undefined;
      if (!commit) continue;
      const expected = (getFiles.all(sha) as { path: string }[]).map((r) => r.path);
      const seeds = opts.seedFilesOf ? opts.seedFilesOf(sha) : [];
      const analogs = historySearch(db, commit.subject, {
        seedFiles: seeds,
        limit: opts.limit ?? 3,
        asOfTs: commit.ts - 1,
        excludeShas: [sha],
        nowSec: opts.nowSec,
      });
      const recalledFiles = new Set<string>();
      for (const a of analogs) for (const f of a.files) recalledFiles.add(f);
      for (const c of coChangeSet(analogs)) recalledFiles.add(c.path);
      const recalled = expected.filter((f) => recalledFiles.has(f));
      out.push({ sha, subject: commit.subject, recalled, expected, recall: expected.length === 0 ? 1 : recalled.length / expected.length });
    }
  } catch (err) {
    logError("history", err);
  }
  return out;
}
