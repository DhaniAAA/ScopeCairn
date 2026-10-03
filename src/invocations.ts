import type { DatabaseSync } from "node:sqlite";

// Invocation log (AI-5): setiap pemanggilan agent tercatat lokal.
// Dipakai Fase 6 untuk compliance rate & analisis penggunaan.
export function logInvocation(
  db: DatabaseSync,
  command: string,
  taskId?: number
): void {
  try {
    db.prepare(`INSERT INTO invocations(task_id, command) VALUES (?, ?)`).run(
      taskId ?? null,
      command
    );
  } catch {
    // logging tak boleh menggagalkan perintah
  }
}
