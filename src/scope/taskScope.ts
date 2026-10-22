import type { DatabaseSync } from "node:sqlite";
import type { TaskScope } from "./scope.js";

// Persistensi scope per task.
//
// Masalah yang diselesaikan: `verify --task "<task>"` sebelumnya menghitung
// ULANG scope dari task string yang sama. Llal path-nya berbeda dari
// `context`, sehingga hasilnya bisa berbeda dari scope yang benar-benar
// dilihat agent:
//
//   1. Co-change riwayat (file yang sering berubah bersama) tidak ikut —
//      `context` meneruskan `historyOptional` ke computeScope, `verify` tidak.
//   2. `--escalate` tidak direproduksi — `context --escalate` memaksa COMPLEX,
//      `verify` tidak pernah mengescalate.
//   3. Task SIMPLE menghasilkan scope kosong → `verify` menandai SETIAP file
//      berubah sebagai pelanggaran.
//
// Solusi: `context` menyimpan scope yang ia render; `verify` memakai scope
// tersimpan itu (kontak yang sama dengan agent). Kalau belum ada (verify
// dijalankan tanpa context sebelumnya), jatuh ke perhitungan ulang — tapi
// lewat jalur yang sama persis, termasuk analogi riwayat.

export type ScopeTier = "required" | "optional" | "protected";

export interface PersistedScope {
  scope: TaskScope;
  taskId: number;
}

/** Simpan scope yang sudah dirender ke agent. */
export function persistScope(db: DatabaseSync, taskId: number, scope: TaskScope): void {
  const ins = db.prepare(
    `INSERT INTO task_scope(task_id, path, tier) VALUES (?, ?, ?)
     ON CONFLICT(task_id, path) DO UPDATE SET tier = excluded.tier`
  );
  const put = (tier: ScopeTier, paths: string[]): void => {
    for (const p of paths) ins.run(taskId, p, tier);
  };
  put("required", scope.required);
  put("optional", scope.optional);
  put("protected", scope.protected);
}

/**
 * Ambil scope dari task TERAKHIR dengan deskripsi yang sama.
 * "Terakhir" penting: `context --escalate` membuat task baru dengan deskripsi
 * sama, dan scope escalate itulah yang terakhir dilihat agent.
 */
export function loadPersistedScope(
  db: DatabaseSync,
  task: string
): PersistedScope | null {
  let row: { id: number } | undefined;
  try {
    row = db
      .prepare(
        `SELECT t.id AS id FROM tasks t
         WHERE t.description = ?
           AND EXISTS (SELECT 1 FROM task_scope s WHERE s.task_id = t.id)
         ORDER BY t.id DESC LIMIT 1`
      )
      .get(task) as { id: number } | undefined;
  } catch {
    return null;
  }
  if (!row) return null;

  const scope: TaskScope = { required: [], optional: [], protected: [] };
  let rows: { path: string; tier: string }[];
  try {
    rows = db
      .prepare(`SELECT path, tier FROM task_scope WHERE task_id = ?`)
      .all(row.id) as { path: string; tier: string }[];
  } catch {
    return null;
  }
  for (const r of rows) {
    if (r.tier === "required") scope.required.push(r.path);
    else if (r.tier === "optional") scope.optional.push(r.path);
    else if (r.tier === "protected") scope.protected.push(r.path);
  }
  return { scope, taskId: row.id };
}

/**
 * Hitung scope untuk task — jalur SAMA dengan `context` (retrieval →
 * classify → analogi riwayat → buildContext), supaya hasil fallback `verify`
 * konsisten dengan yang dilihat agent.
 */
export async function computeTaskScope(
  db: DatabaseSync,
  repoRoot: string,
  task: string,
  opts?: { escalate?: boolean }
): Promise<TaskScope> {
  const { retrieve } = await import("../retrieval/retrieve.js");
  const { classify } = await import("../retrieval/classify.js");
  const { buildContext } = await import("../retrieval/contextBuilder.js");
  const { loadProtectedPatterns } = await import("./protected.js");
  const { historySearch } = await import("../retrieval/history/search.js");

  const result = retrieve(db, repoRoot, task);
  if (result.ranked.length === 0) {
    return { required: [], optional: [], protected: [] };
  }
  const faninOf = (id: number): number => {
    const r = db
      .prepare(`SELECT COUNT(*) AS n FROM relationships WHERE target_id = ?`)
      .get(id) as { n: number };
    return r.n;
  };
  const cls = classify(result.ranked, faninOf, 0.15, loadProtectedPatterns(repoRoot));

  // Analogi riwayat → co-change → promoted ke Optional. Tanpa ini scope
  // fallback kehilangan file yang direkomendasikan sinyal riwayat.
  let analogs: import("../retrieval/history/search.js").HistoryAnalog[] = [];
  try {
    const seedFiles = [
      ...new Set(result.ranked.filter((r) => r.score >= 0.15).map((r) => r.file)),
    ].slice(0, 20);
    analogs = historySearch(db, task, { seedFiles, limit: 3 });
  } catch {
    analogs = [];
  }

  const built = buildContext(db, task, result, cls, {
    escalate: opts?.escalate,
    repoRoot,
    history: analogs.length > 0 ? { analogs } : undefined,
  });
  return built.scope;
}
