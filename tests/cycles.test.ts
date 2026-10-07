import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb } from "../src/db.js";
import type { DatabaseSync } from "node:sqlite";
import {
  stronglyConnected,
  refreshCycles,
  getCycles,
  describeCycle,
  nodeInCycle,
} from "../src/graph/cycles.js";

function setup(): { dir: string; db: DatabaseSync } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scopecairn-cycles-"));
  return { dir, db: openDb(dir) };
}

function addFile(db: DatabaseSync, rel: string): number {
  const r = db
    .prepare(`INSERT INTO files(path, language, hash, size) VALUES (?, 'ts', 'h', 1)`)
    .run(rel);
  return Number(r.lastInsertRowid);
}

function addSym(
  db: DatabaseSync,
  fileId: number,
  name: string,
  type = "function"
): number {
  const r = db
    .prepare(
      `INSERT INTO symbols(file_id, name, type, signature, start_line, end_line)
       VALUES (?, ?, ?, '', 1, 1)`
    )
    .run(fileId, name, type);
  return Number(r.lastInsertRowid);
}

function addEdge(db: DatabaseSync, s: number, t: number): void {
  db
    .prepare(
      `INSERT INTO relationships(source_id, target_id, relationship_type) VALUES (?, ?, 'CALLS')`
    )
    .run(s, t);
}

test("Tarjan mendeteksi siklus 3-node", () => {
  const { dir, db } = setup();
  try {
    const f = addFile(db, "a.ts");
    const a = addSym(db, f, "a");
    const b = addSym(db, f, "b");
    const c = addSym(db, f, "c");
    const d = addSym(db, f, "d");
    addEdge(db, a, b);
    addEdge(db, b, c);
    addEdge(db, c, a);
    const sccs = stronglyConnected(db).sort((x, y) => y.length - x.length);
    assert.equal(sccs[0].length, 3);
    assert.ok(sccs.some((s) => s.length === 1 && s[0] === d));
    refreshCycles(db);
    const cycles = getCycles(db);
    assert.equal(cycles.length, 1);
    assert.equal(cycles[0].length, 3);
    assert.ok(nodeInCycle(db, a));
    assert.ok(!nodeInCycle(db, d));
    const desc = describeCycle(db, cycles[0]);
    assert.ok(desc.includes("a (a.ts)"));
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("self-loop terdeteksi sebagai siklus panjang 1", () => {
  const { dir, db } = setup();
  try {
    const f = addFile(db, "s.ts");
    const a = addSym(db, f, "self");
    addEdge(db, a, a);
    refreshCycles(db);
    const cycles = getCycles(db);
    assert.equal(cycles.length, 1);
    assert.equal(cycles[0].length, 1);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("DAG tanpa siklus menghasilkan cycles kosong", () => {
  const { dir, db } = setup();
  try {
    const f = addFile(db, "dag.ts");
    const a = addSym(db, f, "a");
    const b = addSym(db, f, "b");
    const c = addSym(db, f, "c");
    addEdge(db, a, b);
    addEdge(db, b, c);
    addEdge(db, a, c);
    refreshCycles(db);
    assert.equal(getCycles(db).length, 0);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
