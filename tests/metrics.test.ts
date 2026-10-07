import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb } from "../src/db.js";
import type { DatabaseSync } from "node:sqlite";
import {
  computePageRank,
  computeBetweenness,
  refreshMetrics,
  getMetrics,
  topByPageRank,
} from "../src/graph/metrics.js";

function setup(): { dir: string; db: DatabaseSync } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scopecairn-metrics-"));
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

function addEdge(db: DatabaseSync, s: number, t: number): void {
  db
    .prepare(
      `INSERT INTO relationships(source_id, target_id, relationship_type) VALUES (?, ?, 'CALLS')`
    )
    .run(s, t);
}

test("PageRank: node dengan incoming edge lebih banyak skor lebih tinggi", () => {
  const { dir, db } = setup();
  try {
    const f = addFile(db, "g.ts");
    const a = addSym(db, f, "a");
    const b = addSym(db, f, "b");
    const c = addSym(db, f, "c");
    addEdge(db, a, b);
    addEdge(db, a, c);
    addEdge(db, b, c);
    const pr = computePageRank(db);
    const sum = [...pr.values()].reduce((x, y) => x + y, 0);
    assert.ok(Math.abs(sum - 1) < 1e-6, `PageRank sum = ${sum}`);
    assert.ok(pr.get(c)! > pr.get(a)!, "c menerima 2 edge, a menerima 0");
    assert.ok(pr.get(b)! > pr.get(a)!);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("Betweenness: node tengah rantai punya betweenness tertinggi", () => {
  const { dir, db } = setup();
  try {
    const f = addFile(db, "chain.ts");
    const a = addSym(db, f, "a");
    const b = addSym(db, f, "b");
    const c = addSym(db, f, "c");
    addEdge(db, a, b);
    addEdge(db, b, c);
    const bet = computeBetweenness(db);
    assert.ok(bet.get(b)! > bet.get(a)!);
    assert.ok(bet.get(b)! > bet.get(c)!);
    assert.equal(bet.get(a), 0);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("refreshMetrics menyimpan, getMetrics membaca kembali", () => {
  const { dir, db } = setup();
  try {
    const f = addFile(db, "m.ts");
    const a = addSym(db, f, "a");
    const b = addSym(db, f, "b");
    addEdge(db, a, b);
    const n = refreshMetrics(db);
    assert.equal(n, 2);
    const ma = getMetrics(db, a);
    assert.ok(ma, "metrik a ada");
    assert.equal(ma!.outDegree, 1);
    assert.equal(ma!.inDegree, 0);
    const mb = getMetrics(db, b);
    assert.equal(mb!.inDegree, 1);
    const top = topByPageRank(db, 5);
    assert.equal(top.length, 2);
    assert.equal(top[0].id, b, "b punya PR lebih tinggi dari a");
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
