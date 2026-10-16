// Test laporan usage lokal (Fase 6): dibaca dari invocations/tasks/task_context.
// Tidak ada data yang keluar dari mesin — murni query DB lokal.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { collectUsage, renderUsage } from "../src/usage.js";
import { cmdScan } from "../src/commands/scan.js";
import { openDb } from "../src/db.js";

function memDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      description TEXT NOT NULL,
      complexity TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      completed_at TEXT
    );
    CREATE TABLE task_context (task_id INTEGER, symbol_id INTEGER, score REAL, reason TEXT);
    CREATE TABLE invocations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id INTEGER,
      command TEXT NOT NULL,
      timestamp TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `);
  return db;
}

/** Task 1 closed (scan setelah task), task 2 masih terbuka. */
function seededDb(): DatabaseSync {
  const db = memDb();
  db.exec(`
    INSERT INTO tasks (id, description, created_at) VALUES
      (1, 'task tertutup', datetime('now', '-2 days')),
      (2, 'task terbuka', datetime('now', '-1 hour'));
    INSERT INTO invocations (task_id, command, timestamp) VALUES
      (1, 'context', datetime('now', '-2 days')),
      (NULL, 'scan', datetime('now', '-1 day')),
      (2, 'context', datetime('now', '-1 hour')),
      (NULL, 'graph', datetime('now', '-30 minutes')),
      (NULL, 'verify', datetime('now', '-30 days'));
    INSERT INTO task_context (task_id, symbol_id) VALUES
      (1, 10), (1, 11), (1, 12),
      (2, 20), (2, 21);
  `);
  return db;
}

test("collectUsage menghitung total, per-command, dan aktivitas 7 hari", () => {
  const db = seededDb();
  try {
    const u = collectUsage(db);
    assert.equal(u.total, 5);
    assert.equal(u.last7Days, 4); // 'verify' 30 hari lalu tidak dihitung
    assert.deepEqual(
      u.byCommand.map((c) => c.command),
      ["context", "graph", "scan", "verify"]
    );
    assert.ok(u.firstAt && u.lastAt);
  } finally {
    db.close();
  }
});

test("collectUsage mengukur loop tertutup: scan setelah task dibuat", () => {
  const db = seededDb();
  try {
    const u = collectUsage(db);
    assert.equal(u.tasks, 2);
    assert.equal(u.closedLoop, 1);
    assert.equal(u.avgSymbolsPerTask, 2.5);
    assert.deepEqual(
      u.recentTasks.map((t) => [t.description, t.closed]),
      [
        ["task terbuka", false],
        ["task tertutup", true],
      ]
    );
  } finally {
    db.close();
  }
});

test("renderUsage menampilkan rasio dan tidak membagi nol", () => {
  const empty = collectUsage(memDb());
  const emptyOut = renderUsage(empty);
  assert.ok(emptyOut.includes("Belum ada pemanggilan tercatat"));
  assert.ok(!emptyOut.includes("NaN"));

  const db = seededDb();
  try {
    const out = renderUsage(collectUsage(db));
    assert.ok(out.includes("50%")); // 1 dari 2 task menutup loop
    assert.ok(out.includes("Closed loop"));
    assert.ok(out.includes("context"));
  } finally {
    db.close();
  }
});

test("scan mencatat invocation agar loop bisa diukur", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sc-scanlog-"));
  try {
    fs.mkdirSync(path.join(dir, "src"), { recursive: true });
    fs.writeFileSync(path.join(dir, "src", "a.ts"), "export function halo() { return 1; }\n");
    await cmdScan(dir);
    const db = openDb(dir);
    try {
      const row = db
        .prepare(`SELECT COUNT(*) AS n FROM invocations WHERE command = 'scan'`)
        .get() as { n: number };
      assert.equal(row.n, 1);
    } finally {
      db.close();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
