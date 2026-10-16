import type { DatabaseSync } from "node:sqlite";

// Laporan usage & compliance (PRD AI-5 / §18). Semua angka dibaca dari DB
// lokal .scopecairn/ — tidak ada yang dikirim keluar mesin.
export interface UsageStats {
  total: number;
  firstAt: string | null;
  lastAt: string | null;
  last7Days: number;
  byCommand: { command: string; n: number }[];
  tasks: number;
  /** Task yang diikuti `scan` setelahnya — loop prompt → context → kerja → scan tertutup. */
  closedLoop: number;
  avgSymbolsPerTask: number | null;
  recentTasks: { description: string; symbols: number; closed: boolean }[];
}

export function collectUsage(db: DatabaseSync): UsageStats {
  const agg = db
    .prepare(`SELECT COUNT(*) AS n, MIN(timestamp) AS a, MAX(timestamp) AS b FROM invocations`)
    .get() as { n: number; a: string | null; b: string | null };
  const last7 = db
    .prepare(`SELECT COUNT(*) AS n FROM invocations WHERE timestamp >= datetime('now', '-7 days')`)
    .get() as { n: number };
  const byCommand = db
    .prepare(
      `SELECT command, COUNT(*) AS n FROM invocations GROUP BY command ORDER BY n DESC, command ASC`
    )
    .all() as { command: string; n: number }[];
  const tasks = (db.prepare(`SELECT COUNT(*) AS n FROM tasks`).get() as { n: number }).n;
  const closedLoop = (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM tasks t WHERE EXISTS (
           SELECT 1 FROM invocations i
           WHERE i.command = 'scan' AND i.timestamp >= t.created_at
         )`
      )
      .get() as { n: number }
  ).n;
  const avg = (
    db
      .prepare(`SELECT AVG(c) AS a FROM (SELECT COUNT(*) AS c FROM task_context GROUP BY task_id)`)
      .get() as { a: number | null }
  ).a;
  const recentRows = db
    .prepare(
      `SELECT t.description AS description,
              (SELECT COUNT(*) FROM task_context tc WHERE tc.task_id = t.id) AS symbols,
              EXISTS(
                SELECT 1 FROM invocations i
                WHERE i.command = 'scan' AND i.timestamp >= t.created_at
              ) AS closed
       FROM tasks t ORDER BY t.id DESC LIMIT 5`
    )
    .all() as { description: string; symbols: number; closed: number }[];

  return {
    total: agg.n,
    firstAt: agg.a,
    lastAt: agg.b,
    last7Days: last7.n,
    byCommand,
    tasks,
    closedLoop,
    avgSymbolsPerTask: avg,
    recentTasks: recentRows.map((r) => ({
      description: r.description,
      symbols: r.symbols,
      closed: r.closed === 1,
    })),
  };
}

export function renderUsage(u: UsageStats): string {
  const lines = ["# ScopeCairn Usage", ""];
  if (u.total === 0) {
    lines.push("Belum ada pemanggilan tercatat.");
    lines.push("Jalankan `scopecairn context \"<task>\"` — aktivitas akan muncul di sini.");
    return lines.join("\n");
  }

  lines.push(`Pemanggilan: ${u.total} (${u.firstAt} → ${u.lastAt})`);
  lines.push(`7 hari terakhir: ${u.last7Days}`);
  lines.push("");
  lines.push("Per command:");
  for (const c of u.byCommand) lines.push(`  ${c.command}: ${c.n}`);

  lines.push("");
  lines.push(`Task dijalankan: ${u.tasks}`);
  if (u.tasks > 0) {
    const pct = Math.round((u.closedLoop / u.tasks) * 100);
    lines.push(`Closed loop (scan setelah task): ${u.closedLoop}/${u.tasks} (${pct}%)`);
  } else {
    lines.push("Closed loop (scan setelah task): belum ada task");
  }
  if (u.avgSymbolsPerTask !== null) {
    lines.push(`Rata-rata simbol per task: ${u.avgSymbolsPerTask.toFixed(1)}`);
  }

  if (u.recentTasks.length > 0) {
    lines.push("");
    lines.push("Task terakhir:");
    for (const t of u.recentTasks) {
      lines.push(`  ${t.closed ? "[✓]" : "[ ]"} ${t.description} (${t.symbols} simbol)`);
    }
  }

  lines.push("");
  lines.push(
    "Catatan: dihitung dari log lokal `.scopecairn/` saja — pemanggilan CLI, bukan bukti agent membaca konteks."
  );
  return lines.join("\n");
}
