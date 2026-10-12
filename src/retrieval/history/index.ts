// Tokenisasi + FTS commit untuk Analogi Riwayat.
// Memakai tokenizer yang sama dengan tahap seed (tokenizeIdentifier):
// camelCase/snake_case dipecah, stopword dibuang.

import type { DatabaseSync } from "node:sqlite";
import { tokenizeIdentifier } from "../tokenize.js";
import { logError } from "../../log.js";

/** Buang prefix conventional commit (`feat:`, `fix(scope):`). */
export function stripConventionalPrefix(subject: string): string {
  return subject
    .replace(/^[a-z]+(\([^)]*\))?(!)?:\s*/i, "")
    .replace(/^\[\w+\]\s*/, "")
    .trim();
}

/** True bila subject miskin informasi → indeks memakai token path saja. */
export function isPoorSubject(subject: string): boolean {
  const clean = stripConventionalPrefix(subject);
  if (/^merge\s+(pr|pull request)\s*#?\d*/i.test(clean)) return true;
  if (/^(update|updates|wip|tmp|test|fix|patch|changes?)$/i.test(clean)) return true;
  return tokenizeIdentifier(clean).length < 2;
}

/** Token dokumen commit: subject (+body bila informatif) + token path. */
export function commitTokens(subject: string, body: string, paths: string[]): string[] {
  const out = new Set<string>();
  const cleanSubject = stripConventionalPrefix(subject);
  for (const t of tokenizeIdentifier(cleanSubject)) out.add(t);
  if (!isPoorSubject(subject)) {
    for (const t of tokenizeIdentifier(body.slice(0, 2000))) out.add(t);
  }
  for (const p of paths) {
    for (const t of tokenizeIdentifier(p)) out.add(t);
  }
  return [...out];
}

/** Sinkronkan baris FTS untuk sha tertentu (insert manual per commit). */
export function syncCommitFts(db: DatabaseSync, shas: string[]): number {
  let n = 0;
  try {
    const del = db.prepare(`DELETE FROM commit_fts WHERE sha = ?`);
    const ins = db.prepare(`INSERT INTO commit_fts(sha, subject, body, paths) VALUES (?, ?, ?, ?)`);
    const getCommit = db.prepare(`SELECT subject, body FROM commits WHERE sha = ?`);
    const getPaths = db.prepare(`SELECT path FROM commit_files WHERE sha = ?`);
    for (const sha of shas) {
      const c = getCommit.get(sha) as { subject: string; body: string } | undefined;
      if (!c) continue;
      const paths = (getPaths.all(sha) as { path: string }[]).map((r) => r.path);
      del.run(sha);
      // Kolom disimpan mentah (subject/body/paths); FTS5 menokenisasi
      // sendiri; query memakai token ter-quote OR.
      ins.run(sha, c.subject, c.body.slice(0, 4000), paths.join(" "));
      n++;
    }
  } catch (err) {
    logError("history", err);
  }
  return n;
}

/** Bangun ulang seluruh FTS dari tabel (untuk re-sync setelah rebase). */
export function rebuildCommitFts(db: DatabaseSync): number {
  try {
    const rows = db.prepare(`SELECT sha FROM commits`).all() as { sha: string }[];
    db.prepare(`DELETE FROM commit_fts`).run();
    return syncCommitFts(db, rows.map((r) => r.sha));
  } catch (err) {
    logError("history", err);
    return 0;
  }
}
