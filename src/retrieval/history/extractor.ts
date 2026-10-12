// Ekstraktor riwayat git untuk Analogi Riwayat.
// Gagal lembut: bukan repo git / git tak ada / clone dangkal parsial →
// kembalikan { available: false } tanpa throw, agar scan/context tetap sukses.

import { execFileSync } from "node:child_process";
import type { DatabaseSync } from "node:sqlite";
import { logError } from "../../log.js";

export const HISTORY_MAX_COMMITS = 2000;
export const HISTORY_MAX_FILES_PER_COMMIT = 40;

/** True bila commit dilewati indexing (refactor massal/impor). Murni. */
export function shouldSkipCommit(fileCount: number): boolean {
  return fileCount > HISTORY_MAX_FILES_PER_COMMIT;
}

/** File yang dilewati khusus history (lockfile + generated). Terpisah dari
 *  ignore.ts/protected.ts agar lockfile tetap terindeks sebagai Protected. */
const HISTORY_SKIP_BASENAMES = new Set([
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lockb",
  "cargo.lock",
  "go.sum",
  "gemfile.lock",
  "poetry.lock",
]);

const HISTORY_SKIP_SUFFIXES = [".min.js", ".map", ".lock"];

const HISTORY_SKIP_DIRS = ["dist/", "build/", "coverage/", "node_modules/", ".next/"];

export function isHistorySkipped(posixPath: string): boolean {
  const base = posixPath.split("/").pop() ?? posixPath;
  if (HISTORY_SKIP_BASENAMES.has(base)) return true;
  for (const s of HISTORY_SKIP_SUFFIXES) if (base.endsWith(s)) return true;
  for (const d of HISTORY_SKIP_DIRS) if (posixPath.startsWith(d)) return true;
  return false;
}

export interface RawCommitFile {
  status: string;
  path: string;
  oldPath: string | null;
  additions: number;
  deletions: number;
}

export interface RawCommit {
  sha: string;
  ts: number;
  author: string;
  subject: string;
  body: string;
  files: RawCommitFile[];
}

function runGit(repoRoot: string, args: string[], timeout = 30000): string | null {
  try {
    return execFileSync("git", args, {
      cwd: repoRoot,
      encoding: "utf8",
      timeout,
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch (err) {
    logError("history", err, repoRoot);
    return null;
  }
}

export function isShallowRepo(repoRoot: string): boolean {
  try {
    const out = execFileSync("git", ["rev-parse", "--is-shallow-repository"], {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: 8000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return out === "true";
  } catch {
    return false;
  }
}

// Pemisah git log: unit separator antar field header, record separator
// akhir header, dan pemisah subject/body. Dibangun via fromCharCode agar
// tak ada karakter kontrol tak terlihat di source.
const FS = String.fromCharCode(1);
const RS = String.fromCharCode(30);
const SB = String.fromCharCode(31);

/**
 * Parse output `git log --no-merges --format=<sha><FS><ts><FS><author><FS>
 * <subject><SB><body><RS> --name-status -M --numstat`. Berbasis baris:
 * baris header dikenali dari FS (baris file tak pernah mengandungnya).
 * Murni (tanpa git/DB) agar mudah diuji.
 */
export function parseGitLog(out: string): RawCommit[] {
  const commits: RawCommit[] = [];
  let cur: RawCommit | null = null;
  let numstat = new Map<string, { a: number; d: number }>();
  let statuses: { st: string; p: string; old: string | null }[] = [];
  const flush = (): void => {
    if (!cur) return;
    for (const s of statuses) {
      const n = numstat.get(s.p) ?? { a: 0, d: 0 };
      cur.files.push({ status: s.st, path: s.p, oldPath: s.old, additions: n.a, deletions: n.d });
    }
    commits.push(cur);
  };
  for (const rawLine of out.replace(new RegExp(RS, "g"), "").split("\n")) {
    const line = rawLine.trimEnd();
    if (!line.trim()) continue;
    if (line.includes(FS)) {
      flush();
      const [sha, tsRaw, author, subjectBody = ""] = line.split(FS);
      if (!sha || !/^[0-9a-f]{4,}$/.test(sha.trim())) {
        cur = null;
        numstat = new Map();
        statuses = [];
        continue;
      }
      // Subject dan body berada di satu baris header yang sama.
      const sep = subjectBody.indexOf(SB);
      cur = {
        sha: sha.trim(),
        ts: Number((tsRaw ?? "").trim()) || 0,
        author: (author ?? "").trim(),
        subject: (sep === -1 ? subjectBody : subjectBody.slice(0, sep)).trim(),
        body: (sep === -1 ? "" : subjectBody.slice(sep + 1)).trim(),
        files: [],
      };
      numstat = new Map();
      statuses = [];
      continue;
    }
    if (!cur) continue;
    const t = line.trim();
    const num = t.match(/^(\d+|-)\t(\d+|-)\t(.+)$/);
    if (num) {
      numstat.set(num[3].trim(), {
        a: num[1] === "-" ? 0 : Number(num[1]),
        d: num[2] === "-" ? 0 : Number(num[2]),
      });
      continue;
    }
    const m = t.match(/^([AMDRCTUXB])(\d*)\t(.+)$/);
    if (!m) continue;
    const parts = m[3].split("\t");
    if (m[1] === "R" && parts.length >= 2) {
      statuses.push({ st: "R", p: parts[1].trim(), old: parts[0].trim() });
    } else {
      statuses.push({ st: m[1], p: parts[0].trim(), old: null });
    }
  }
  flush();
  return commits;
}

export interface HistorySyncResult {
  available: boolean;
  indexed: number;
  skipped: number;
  shallow: boolean;
  /** Sha yang baru terindeks pada pemanggilan ini (untuk sinkron FTS). */
  shas: string[];
}

/**
 * Index riwayat secara inkremental dari meta.history_last_sha ke HEAD.
 * Idempoten (INSERT OR IGNORE). Best-effort: tak pernah throw.
 */
export function ensureHistoryIndex(
  db: DatabaseSync,
  repoRoot: string,
  opts?: { maxCommits?: number }
): HistorySyncResult {
  const maxCommits = Math.max(1, Math.min(5000, opts?.maxCommits ?? HISTORY_MAX_COMMITS));
  const fail = (shallow = false): HistorySyncResult => ({ available: false, indexed: 0, skipped: 0, shallow, shas: [] });
  // Hitung baseline agar inkremental bisa diukur walau tanpa penanda.
  let before = 0;
  try {
    before = (db.prepare(`SELECT COUNT(*) AS n FROM commits`).get() as { n: number }).n;
  } catch (err) {
    logError("history", err, repoRoot);
    return fail();
  }
  const lastRow = (() => {
    try {
      return db.prepare(`SELECT value FROM meta WHERE key = 'history_last_sha'`).get() as
        | { value: string }
        | undefined;
    } catch {
      return undefined;
    }
  })();
  const lastSha = lastRow?.value;
  // Daftar sha terbaru (batas 2x agar deteksi rebase/shallow murah).
  const headList = runGit(repoRoot, ["log", "--no-merges", `--max-count=${maxCommits * 2}`, "--format=%H"]);
  if (!headList) return fail(isShallowRepo(repoRoot));
  const headShas = headList.split("\n").map((s) => s.trim()).filter(Boolean);
  if (headShas.length === 0) return { available: true, indexed: 0, skipped: 0, shallow: isShallowRepo(repoRoot), shas: [] };
  const shallow = isShallowRepo(repoRoot);
  // Bila penanda hilang (rebase/shallow ulang) → sinkron terbatas 2000 teratas.
  let range: string[];
  if (lastSha && headShas.includes(lastSha)) {
    range = headShas.slice(0, Math.max(0, headShas.indexOf(lastSha)));
  } else {
    range = headShas.slice(0, maxCommits);
  }
  if (range.length === 0) {
    return { available: true, indexed: 0, skipped: 0, shallow, shas: [] };
  }
  // Ambil detail hanya untuk rentang baru (atau 2000 teratas bila re-sync).
  const oldest = range[range.length - 1];
  const newest = range[0];
  const detailRange = lastSha && headShas.includes(lastSha) ? `${oldest}..${newest}` : `--max-count=${Math.min(maxCommits, range.length)}`;
  const format = `%H${FS}%ct${FS}%an${FS}%s${SB}%b${RS}`;
  const detailArgs =
    detailRange.startsWith("--max-count")
      ? ["log", "--no-merges", detailRange, `--format=${format}`, "--name-status", "-M", "--numstat", "--", "."]
      : ["log", "--no-merges", `--format=${format}`, "--name-status", "-M", "--numstat", detailRange, "--", "."];
  const detail = runGit(repoRoot, detailArgs);
  if (!detail) return fail(shallow);
  let parsed: RawCommit[];
  try {
    parsed = parseGitLog(detail);
  } catch (err) {
    logError("history", err, repoRoot);
    return fail(shallow);
  }
  let indexed = 0;
  let skipped = 0;
  const shas: string[] = [];
  try {
    const insCommit = db.prepare(
      `INSERT OR IGNORE INTO commits(sha, ts, subject, body, author) VALUES (?, ?, ?, ?, ?)`
    );
    const insFile = db.prepare(
      `INSERT INTO commit_files(sha, path, status, old_path, additions, deletions) VALUES (?, ?, ?, ?, ?, ?)`
    );
    const delFiles = db.prepare(`DELETE FROM commit_files WHERE sha = ?`);
    for (const c of parsed.slice(0, maxCommits)) {
      const kept = c.files.filter((f) => !isHistorySkipped(f.path));
      if (shouldSkipCommit(c.files.length)) {
        skipped++;
        continue;
      }
      const r = insCommit.run(c.sha, c.ts, c.subject, c.body, c.author);
      if (Number(r.changes) === 0) continue; // sudah terindeks
      delFiles.run(c.sha);
      for (const f of kept) {
        insFile.run(c.sha, f.path, f.status, f.oldPath, f.additions, f.deletions);
      }
      indexed++;
      shas.push(c.sha);
    }
    // FTS disinkronkan oleh pemanggil (syncCommitFts di index.ts) agar
    // tokenizer terpusat dan modul ini tetap murni git→tabel.
  } catch (err) {
    logError("history", err, repoRoot);
  }
  // Penanda maju ke HEAD apa pun yang terjadi (hindari pengulangan gagal).
  try {
    db.prepare(
      `INSERT INTO meta(key, value) VALUES ('history_last_sha', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    ).run(headShas[0]);
  } catch (err) {
    logError("history", err, repoRoot);
  }
  void before;
  return { available: true, indexed, skipped, shallow, shas };
}
