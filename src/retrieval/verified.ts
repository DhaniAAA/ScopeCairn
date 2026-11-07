import type { DatabaseSync } from "node:sqlite";
import { tokenizeTask } from "./tokenize.js";

export interface VerifiedAnalog {
  taskId?: number;
  description: string;
  files: string[];
  verifiedAt: string;
  score: number;
}

/**
 * Catat hasil verifikasi yang sukses ke SQLite untuk pembelajaran loop tertutup.
 */
export function recordVerifiedTask(
  db: DatabaseSync,
  task: string,
  changedFiles: string[],
  taskId?: number
): void {
  const cleanTask = task.trim();
  const normalizedFiles = [...new Set(changedFiles.map((f) => f.replace(/\\/g, "/")))].filter(Boolean);
  if (!cleanTask || normalizedFiles.length === 0) return;

  try {
    let tId = taskId;
    if (!tId) {
      const row = db
        .prepare(`SELECT id FROM tasks WHERE description = ? ORDER BY id DESC LIMIT 1`)
        .get(cleanTask) as { id: number } | undefined;
      tId = row?.id;
    }
    if (tId) {
      try {
        db.prepare(`UPDATE tasks SET completed_at = datetime('now') WHERE id = ?`).run(tId);
      } catch {
        // ignore
      }
    }

    const filesJson = JSON.stringify(normalizedFiles);
    const filesText = normalizedFiles.join(" ");

    db.prepare(
      `INSERT INTO verified_tasks(task_id, description, files_json, verified_at)
       VALUES (?, ?, ?, datetime('now'))
       ON CONFLICT(description) DO UPDATE SET
         task_id = excluded.task_id,
         files_json = excluded.files_json,
         verified_at = datetime('now')`
    ).run(tId ?? null, cleanTask, filesJson);

    try {
      db.prepare(`DELETE FROM verified_tasks_fts WHERE description = ?`).run(cleanTask);
      db.prepare(
        `INSERT INTO verified_tasks_fts(task_id, description, files) VALUES (?, ?, ?)`
      ).run(tId ?? null, cleanTask, filesText);
    } catch {
      // FTS sync best-effort
    }
  } catch {
    // best-effort learning
  }
}

function tokenSimilarity(aTokens: string[], bTokens: string[]): number {
  if (aTokens.length === 0 || bTokens.length === 0) return 0;
  const aSet = new Set(aTokens);
  const bSet = new Set(bTokens);
  let inter = 0;
  for (const t of aSet) {
    if (bSet.has(t)) inter++;
  }
  const union = aSet.size + bSet.size - inter;
  return union === 0 ? 0 : inter / union;
}

/**
 * Cari task terverifikasi terdahulu yang mirip dengan task saat ini.
 */
export function findVerifiedAnalogs(
  db: DatabaseSync,
  task: string,
  limit = 3
): VerifiedAnalog[] {
  const queryTokens = tokenizeTask(task);
  if (queryTokens.length === 0) return [];

  const candidates = new Map<string, { taskId?: number; description: string; files: string[]; verifiedAt: string }>();

  // 1. Coba FTS5 match
  try {
    const q = queryTokens.map((t) => `"${t.replace(/"/g, "")}"`).join(" OR ");
    const rows = db
      .prepare(
        `SELECT v.task_id, v.description, v.files_json, v.verified_at
         FROM verified_tasks_fts f
         JOIN verified_tasks v ON v.description = f.description
         WHERE verified_tasks_fts MATCH ?
         LIMIT 10`
      )
      .all(q) as { task_id: number | null; description: string; files_json: string; verified_at: string }[];

    for (const r of rows) {
      try {
        const files = JSON.parse(r.files_json) as string[];
        candidates.set(r.description, {
          taskId: r.task_id ?? undefined,
          description: r.description,
          files,
          verifiedAt: r.verified_at,
        });
      } catch {
        // ignore malformed json
      }
    }
  } catch {
    // FTS query gagal atau tabel belum ada
  }

  // 2. Fallback: ambil semua / 30 task terakhir dan ukur kemiripan token
  try {
    const rows = db
      .prepare(`SELECT task_id, description, files_json, verified_at FROM verified_tasks ORDER BY id DESC LIMIT 50`)
      .all() as { task_id: number | null; description: string; files_json: string; verified_at: string }[];

    for (const r of rows) {
      if (candidates.has(r.description)) continue;
      try {
        const files = JSON.parse(r.files_json) as string[];
        candidates.set(r.description, {
          taskId: r.task_id ?? undefined,
          description: r.description,
          files,
          verifiedAt: r.verified_at,
        });
      } catch {
        // ignore
      }
    }
  } catch {
    return [];
  }

  const scored: VerifiedAnalog[] = [];
  for (const c of candidates.values()) {
    const cTokens = tokenizeTask(c.description);
    const score = tokenSimilarity(queryTokens, cTokens);
    if (score >= 0.2 || c.description.toLowerCase() === task.trim().toLowerCase()) {
      scored.push({
        taskId: c.taskId,
        description: c.description,
        files: c.files,
        verifiedAt: c.verifiedAt,
        score: c.description.toLowerCase() === task.trim().toLowerCase() ? 1.0 : score,
      });
    }
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}
