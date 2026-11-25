import type { DatabaseSync } from "node:sqlite";

export interface InvocationMetrics {
  fullBytes?: number;
  returnedBytes?: number;
}

// Invocation log (AI-5): setiap pemanggilan agent tercatat lokal.
// Dipakai Fase 6 untuk compliance rate & analisis penghematan konteks.
export function logInvocation(
  db: DatabaseSync,
  command: string,
  taskId?: number,
  metrics?: InvocationMetrics
): number | null {
  try {
    const fullBytes = Math.max(0, Math.round(metrics?.fullBytes ?? 0));
    const returnedBytes = Math.max(0, Math.round(metrics?.returnedBytes ?? 0));
    const r = db
      .prepare(
        `INSERT INTO invocations(task_id, command, full_bytes, returned_bytes) VALUES (?, ?, ?, ?)`
      )
      .run(taskId ?? null, command, fullBytes, returnedBytes);
    return Number(r.lastInsertRowid);
  } catch {
    try {
      const r = db
        .prepare(`INSERT INTO invocations(task_id, command) VALUES (?, ?)`)
        .run(taskId ?? null, command);
      return Number(r.lastInsertRowid);
    } catch {
      // logging tak boleh menggagalkan perintah
      return null;
    }
  }
}

/** Perbarui metrik byte penuh vs excerpt yang dikembalikan untuk satu invocation. */
export function recordInvocationSavings(
  db: DatabaseSync,
  invocationId: number | null,
  fullBytes: number,
  returnedBytes: number
): void {
  if (!invocationId || fullBytes <= 0) return;
  try {
    db.prepare(
      `UPDATE invocations SET full_bytes = ?, returned_bytes = ? WHERE id = ?`
    ).run(Math.max(0, Math.round(fullBytes)), Math.max(0, Math.round(returnedBytes)), invocationId);
  } catch {
    // metrik bersifat opsional — skema lama tanpa kolom aman diabaikan
  }
}
