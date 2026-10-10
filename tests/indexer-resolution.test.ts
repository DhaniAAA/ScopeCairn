import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/db.js";
import { indexFileSymbols, indexFileRelations } from "../src/indexer.js";
import { prepareTreeSitter } from "../src/treesitter.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

await prepareTreeSitter(["typescript", "javascript", "python", "go"]);

test("cross-file resolution menghubungkan CALLS ke symbol di target import eksak", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "scopecairn-res-test-"));
  const db = openDb(tmpDir);
  try {
    const f1 = db.prepare(`INSERT INTO files(path, language, hash, size) VALUES ('src/math.ts', 'typescript', 'h1', 100)`).run();
    const f2 = db.prepare(`INSERT INTO files(path, language, hash, size) VALUES ('src/calc.ts', 'typescript', 'h2', 100)`).run();
    const f3 = db.prepare(`INSERT INTO files(path, language, hash, size) VALUES ('src/other.ts', 'typescript', 'h3', 100)`).run();
    const fileIdMath = Number(f1.lastInsertRowid);
    const fileIdCalc = Number(f2.lastInsertRowid);
    const fileIdOther = Number(f3.lastInsertRowid);

    const mathContent = `export function add(a: number, b: number) { return a + b; }`;
    const mathExt = indexFileSymbols(db, fileIdMath, "src/math.ts", mathContent);
    indexFileRelations(db, fileIdMath, "src/math.ts", mathExt.extraction, mathExt.fileSym);

    const otherContent = `export function add(a: number, b: number) { return a - b; }`;
    const otherExt = indexFileSymbols(db, fileIdOther, "src/other.ts", otherContent);
    indexFileRelations(db, fileIdOther, "src/other.ts", otherExt.extraction, otherExt.fileSym);

    const calcContent = `import { add } from "./math";\nexport function calculate() { return add(1, 2); }`;
    const calcExt = indexFileSymbols(db, fileIdCalc, "src/calc.ts", calcContent);
    indexFileRelations(db, fileIdCalc, "src/calc.ts", calcExt.extraction, calcExt.fileSym);

    const mathAddSym = db.prepare(`SELECT id FROM symbols WHERE file_id = ? AND name = 'add'`).get(fileIdMath) as { id: number };
    const calcSym = db.prepare(`SELECT id FROM symbols WHERE file_id = ? AND name = 'calculate'`).get(fileIdCalc) as { id: number };

    const callRel = db.prepare(`SELECT target_id, confidence, evidence FROM relationships WHERE source_id = ? AND relationship_type = 'CALLS'`).get(calcSym.id) as { target_id: number; confidence: number; evidence: string } | undefined;

    assert.ok(callRel, "Relasi CALLS harus terbentuk");
    assert.equal(callRel.target_id, mathAddSym.id, "CALLS harus mengarah ke math.ts add, bukan other.ts");
    assert.ok(callRel.confidence >= 0.9, "Confidence resolusi eksak import harus >= 0.9");
    assert.equal(callRel.evidence, "EXTRACTED");
  } finally {
    try { db.close(); } catch {}
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
});

test("cross-file receiver call menghubungkan namespace/pkg call ke modul target", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "scopecairn-res-test2-"));
  const db = openDb(tmpDir);
  try {
    const f1 = db.prepare(`INSERT INTO files(path, language, hash, size) VALUES ('src/utils.ts', 'typescript', 'h1', 100)`).run();
    const f2 = db.prepare(`INSERT INTO files(path, language, hash, size) VALUES ('src/main.ts', 'typescript', 'h2', 100)`).run();
    const fileIdUtils = Number(f1.lastInsertRowid);
    const fileIdMain = Number(f2.lastInsertRowid);

    const utilsContent = `export function format() { return "ok"; }`;
    const utilsExt = indexFileSymbols(db, fileIdUtils, "src/utils.ts", utilsContent);
    indexFileRelations(db, fileIdUtils, "src/utils.ts", utilsExt.extraction, utilsExt.fileSym);

    const mainContent = `import * as u from "./utils";\nexport function run() { return u.format(); }`;
    const mainExt = indexFileSymbols(db, fileIdMain, "src/main.ts", mainContent);
    indexFileRelations(db, fileIdMain, "src/main.ts", mainExt.extraction, mainExt.fileSym);

    const utilsFormatSym = db.prepare(`SELECT id FROM symbols WHERE file_id = ? AND name = 'format'`).get(fileIdUtils) as { id: number };
    const runSym = db.prepare(`SELECT id FROM symbols WHERE file_id = ? AND name = 'run'`).get(fileIdMain) as { id: number };

    const callRel = db.prepare(`SELECT target_id, confidence FROM relationships WHERE source_id = ? AND relationship_type = 'CALLS'`).get(runSym.id) as { target_id: number; confidence: number } | undefined;

    assert.ok(callRel, "Relasi CALLS untuk receiver call harus terbentuk");
    assert.equal(callRel.target_id, utilsFormatSym.id, "CALLS harus mengarah ke utils.ts format");
  } finally {
    try { db.close(); } catch {}
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
});
