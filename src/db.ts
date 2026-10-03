import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import { createRequire } from "node:module";

function loadDatabaseSync(): typeof DatabaseSyncType {
  // Constructed specifier so tsup/esbuild doesn't rewrite "node:sqlite" -> "sqlite".
  const req = createRequire(import.meta.url);
  const spec = "node:" + "sqlite";
  const m = req(spec) as { DatabaseSync: typeof DatabaseSyncType };
  return m.DatabaseSync;
}

export const DATA_DIR_NAME = ".scopecairn";
export const DB_FILE_NAME = "scopecairn.db";
export const SCHEMA_VERSION = 4;

export function dataDir(repoRoot: string): string {
  return path.join(repoRoot, DATA_DIR_NAME);
}

export function dbPath(repoRoot: string): string {
  return path.join(dataDir(repoRoot), DB_FILE_NAME);
}

export function openDb(repoRoot: string): DatabaseSyncType {
  fs.mkdirSync(dataDir(repoRoot), { recursive: true });
  const DatabaseSync = loadDatabaseSync();
  const db = new DatabaseSync(dbPath(repoRoot));
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      path TEXT NOT NULL UNIQUE,
      language TEXT NOT NULL,
      hash TEXT NOT NULL,
      size INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS symbols (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      signature TEXT NOT NULL DEFAULT '',
      start_line INTEGER NOT NULL DEFAULT 1,
      end_line INTEGER NOT NULL DEFAULT 1
    );
    CREATE INDEX IF NOT EXISTS idx_symbols_file ON symbols(file_id);
    CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(name);
    CREATE INDEX IF NOT EXISTS idx_symbols_type ON symbols(type);
    CREATE TABLE IF NOT EXISTS relationships (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_id INTEGER NOT NULL REFERENCES symbols(id) ON DELETE CASCADE,
      target_id INTEGER NOT NULL REFERENCES symbols(id) ON DELETE CASCADE,
      relationship_type TEXT NOT NULL,
      weight REAL NOT NULL DEFAULT 0.5,
      confidence REAL NOT NULL DEFAULT 1.0
    );
    CREATE INDEX IF NOT EXISTS idx_rel_source ON relationships(source_id);
    CREATE INDEX IF NOT EXISTS idx_rel_target ON relationships(target_id);
    CREATE INDEX IF NOT EXISTS idx_rel_type ON relationships(relationship_type);
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    -- Fase 3: FTS5 symbol index (token match, bukan embedding).
    CREATE VIRTUAL TABLE IF NOT EXISTS symbol_index USING fts5(
      symbol_id UNINDEXED, tokens
    );
    CREATE TABLE IF NOT EXISTS tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      description TEXT NOT NULL,
      complexity TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      completed_at TEXT
    );
    CREATE TABLE IF NOT EXISTS task_context (
      task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      symbol_id INTEGER NOT NULL REFERENCES symbols(id) ON DELETE CASCADE,
      score REAL NOT NULL DEFAULT 0,
      reason TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS idx_task_context_task ON task_context(task_id);
    -- Fase 5: invocation log untuk compliance rate (AI-5, §18).
    CREATE TABLE IF NOT EXISTS invocations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id INTEGER REFERENCES tasks(id) ON DELETE SET NULL,
      command TEXT NOT NULL,
      timestamp TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_invocations_cmd ON invocations(command);
  `);
  db.prepare(
    `INSERT INTO meta(key, value) VALUES ('schema_version', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(String(SCHEMA_VERSION));
  // Fase 2+3 tables are created via IF NOT EXISTS, so older DBs
  // migrate automatically on next open.
  return db;
}

export function hashContent(buf: Buffer): string {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

export interface FileRow {
  id: number;
  path: string;
  language: string;
  hash: string;
  size: number;
}
