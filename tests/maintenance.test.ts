import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb } from "../src/db.js";
import type { DatabaseSync } from "node:sqlite";
import { cleanupOrphans } from "../src/adapters/types.js";

function setup(): { dir: string; db: DatabaseSync } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scopecairn-orphan-"));
  return { dir, db: openDb(dir) };
}

function addFile(db: DatabaseSync, rel: string): number {
  const r = db
    .prepare(`INSERT INTO files(path, language, hash, size) VALUES (?, 'ts', 'h', 1)`)
    .run(rel);
  return Number(r.lastInsertRowid);
}

function addSym(db: DatabaseSync, fileId: number, name: string): number {
  const r = db
    .prepare(
      `INSERT INTO symbols(file_id, name, type, signature, start_line, end_line)
       VALUES (?, ?, 'function', '', 1, 1)`
    )
    .run(fileId, name);
  return Number(r.lastInsertRowid);
}

test("cleanupOrphans mengembalikan 0 pada DB bersih", () => {
  const { dir, db } = setup();
  try {
    const f = addFile(db, "a.ts");
    const a = addSym(db, f, "a");
    const b = addSym(db, f, "b");
    db
      .prepare(
        `INSERT INTO relationships(source_id, target_id, relationship_type) VALUES (?, ?, 'CALLS')`
      )
      .run(a, b);
    assert.equal(cleanupOrphans(db), 0);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("cleanupOrphans menghapus edge terlantar (FK sempat mati)", () => {
  const { dir, db } = setup();
  try {
    const f = addFile(db, "a.ts");
    const a = addSym(db, f, "a");
    // Simulasi DB lama / koneksi tanpa PRAGMA foreign_keys:
    // sisipkan edge yang menunjuk simbol tak ada.
    db.exec("PRAGMA foreign_keys = OFF");
    db
      .prepare(
        `INSERT INTO relationships(source_id, target_id, relationship_type) VALUES (?, ?, 'QUERIES')`
      )
      .run(999999, a);
    db
      .prepare(
        `INSERT INTO relationships(source_id, target_id, relationship_type) VALUES (?, ?, 'QUERIES')`
      )
      .run(a, 999999);
    db.exec("PRAGMA foreign_keys = ON");
    const removed = cleanupOrphans(db);
    assert.equal(removed, 2);
    const cnt = db
      .prepare(`SELECT COUNT(*) AS c FROM relationships`)
      .get() as { c: number };
    assert.equal(cnt.c, 0);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("cleanupOrphans menghapus node_metrics/clusters terlantar", () => {
  const { dir, db } = setup();
  try {
    const f = addFile(db, "a.ts");
    const a = addSym(db, f, "a");
    db.exec("PRAGMA foreign_keys = OFF");
    db
      .prepare(
        `INSERT INTO node_metrics(node_id, pagerank, betweenness, in_degree, out_degree)
         VALUES (?, 0.1, 0.0, 0, 0)`
      )
      .run(888888);
    db
      .prepare(`INSERT INTO clusters(node_id, cluster_id) VALUES (?, 1)`)
      .run(888888);
    db.exec("PRAGMA foreign_keys = ON");
    const removed = cleanupOrphans(db);
    assert.equal(removed, 2);
    const m = db
      .prepare(`SELECT COUNT(*) AS c FROM node_metrics`)
      .get() as { c: number };
    assert.equal(m.c, 0);
    const cl = db
      .prepare(`SELECT COUNT(*) AS c FROM clusters`)
      .get() as { c: number };
    assert.equal(cl.c, 0);
    // simbol a masih utuh
    const s = db
      .prepare(`SELECT COUNT(*) AS c FROM symbols WHERE id = ?`)
      .get(a) as { c: number };
    assert.equal(s.c, 1);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
