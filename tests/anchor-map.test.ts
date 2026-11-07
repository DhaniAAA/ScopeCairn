import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb } from "../src/db.js";
import { indexFileSymbols, indexFileRelations } from "../src/indexer.js";
import { prepareTreeSitter } from "../src/treesitter.js";
import { retrieve, anchorSeeds } from "../src/retrieval/retrieve.js";
import { buildMap } from "../src/commands/map.js";

await prepareTreeSitter(["typescript"]);

function seed(tmp: string) {
  const db = openDb(tmp);
  const add = (p: string, src: string) => {
    const id = Number(db.prepare(`INSERT INTO files(path, language, hash, size) VALUES (?, 'typescript', 'h', 1)`).run(p).lastInsertRowid);
    const ext = indexFileSymbols(db, id, p, src);
    indexFileRelations(db, id, p, ext.extraction, ext.fileSym);
  };
  add("src/auth/service.ts", `export function verifyCredentials(u: string) { return u.length > 0; }`);
  add("src/auth/session.ts", `import { verifyCredentials } from "./service";\nexport function openSession(u: string) { return verifyCredentials(u); }`);
  add("src/billing/invoice.ts", `export function createInvoice() { return 1; }`);
  return db;
}

test("anchor: task tanpa kata yang cocok tetap menemukan file pilihan agent + tetangganya", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "scopecairn-anchor-"));
  const db = seed(tmp);
  try {
    const task = "perbaiki login lambat";
    assert.equal(retrieve(db, tmp, task).ranked.length, 0, "tanpa anchor seed leksikal meleset");
    const files = new Set(retrieve(db, tmp, task, { anchors: ["src/auth/service.ts"] }).ranked.map((r) => r.file));
    assert.ok(files.has("src/auth/service.ts"));
    assert.ok(files.has("src/auth/session.ts"), "tetangga graph ikut");
    assert.ok(!files.has("src/billing/invoice.ts"));
  } finally {
    db.close();
  }
});

test("anchorSeeds: folder, backslash, ./ dan prefix palsu ditangani", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "scopecairn-anchor-"));
  const db = seed(tmp);
  try {
    assert.ok(anchorSeeds(db, ["./src\\auth/"]).length >= 4);
    assert.equal(anchorSeeds(db, ["src/aut"]).length, 0, "prefix bukan folder tak boleh cocok");
    assert.equal(anchorSeeds(db, ["", "  "]).length, 0);
  } finally {
    db.close();
  }
});

test("buildMap: satu baris per file, bisa dibatasi folder", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "scopecairn-map-"));
  const db = seed(tmp);
  try {
    const all = buildMap(db);
    assert.match(all, /- service\.ts: verifyCredentials/);
    assert.match(all, /## src\/billing\//);
    const auth = buildMap(db, "src/auth");
    assert.ok(!auth.includes("invoice"));
  } finally {
    db.close();
  }
});
