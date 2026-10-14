import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/db.js";
import { extractFile } from "../src/extract/index.js";
import { indexFileSymbols, indexFileRelations } from "../src/indexer.js";
import { prepareTreeSitter } from "../src/treesitter.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

await prepareTreeSitter(["typescript", "javascript", "python"]);

test("TypeScript parameter dan return type diekstrak sebagai relasi ber-tipe", () => {
  const code = `
interface Order {}
interface ResponseModel {}

export function createOrder(order: Order, count: number): Promise<ResponseModel> {
  return Promise.resolve({} as ResponseModel);
}
`;
  const result = extractFile("src/order.ts", code);
  const paramRel = result.relations.find((r) => r.from === "createOrder" && r.to === "Order" && r.rel === "PARAM_TYPE");
  const retRel = result.relations.find((r) => r.from === "createOrder" && r.to === "ResponseModel" && r.rel === "RETURN_TYPE");

  assert.ok(paramRel, "Relasi PARAM_TYPE harus terbentuk untuk parameter Order");
  assert.equal(paramRel.confidence, 0.9);

  assert.ok(retRel, "Relasi RETURN_TYPE harus terbentuk untuk generic Promise<ResponseModel>");
  assert.equal(retRel.confidence, 0.9);
});

test("TypeScript class implements interface diekstrak sebagai IMPLEMENTS", () => {
  const code = `
interface IRepository {}
interface IAuditable {}

export class UserRepository implements IRepository, IAuditable {}
`;
  const result = extractFile("src/userRepo.ts", code);
  const repoRel = result.relations.find((r) => r.from === "UserRepository" && r.to === "IRepository" && r.rel === "IMPLEMENTS");
  const auditRel = result.relations.find((r) => r.from === "UserRepository" && r.to === "IAuditable" && r.rel === "IMPLEMENTS");

  assert.ok(repoRel, "Relasi IMPLEMENTS IRepository harus terbentuk");
  assert.ok(auditRel, "Relasi IMPLEMENTS IAuditable harus terbentuk");
  assert.ok(repoRel.confidence >= 0.9);
});

test("Semantic Typed Resolution: resolusi method call presisi berdasarkan tipe receiver variabel/parameter", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "scopecairn-typed-res-"));
  const db = openDb(tmpDir);
  try {
    const f1 = db.prepare(`INSERT INTO files(path, language, hash, size) VALUES ('src/models/user.ts', 'typescript', 'h1', 100)`).run();
    const f2 = db.prepare(`INSERT INTO files(path, language, hash, size) VALUES ('src/other.ts', 'typescript', 'h2', 100)`).run();
    const f3 = db.prepare(`INSERT INTO files(path, language, hash, size) VALUES ('src/service.ts', 'typescript', 'h3', 100)`).run();
    const fileIdUser = Number(f1.lastInsertRowid);
    const fileIdOther = Number(f2.lastInsertRowid);
    const fileIdService = Number(f3.lastInsertRowid);

    const userContent = `export class User {\n  save() { return true; }\n}`;
    const userExt = indexFileSymbols(db, fileIdUser, "src/models/user.ts", userContent);
    indexFileRelations(db, fileIdUser, "src/models/user.ts", userExt.extraction, userExt.fileSym);

    const otherContent = `export class Other {\n  save() { return false; }\n}`;
    const otherExt = indexFileSymbols(db, fileIdOther, "src/other.ts", otherContent);
    indexFileRelations(db, fileIdOther, "src/other.ts", otherExt.extraction, otherExt.fileSym);

    const serviceContent = `import { User } from "./models/user";\nexport function processUser(u: User) {\n  u.save();\n}`;
    const serviceExt = indexFileSymbols(db, fileIdService, "src/service.ts", serviceContent);
    indexFileRelations(db, fileIdService, "src/service.ts", serviceExt.extraction, serviceExt.fileSym);

    const userSaveSym = db.prepare(`SELECT id FROM symbols WHERE file_id = ? AND name = 'save'`).get(fileIdUser) as { id: number };
    const otherSaveSym = db.prepare(`SELECT id FROM symbols WHERE file_id = ? AND name = 'save'`).get(fileIdOther) as { id: number };
    const processSym = db.prepare(`SELECT id FROM symbols WHERE file_id = ? AND name = 'processUser'`).get(fileIdService) as { id: number };

    // Periksa relasi PARAM_TYPE dari processUser -> User
    const paramRel = db.prepare(`SELECT target_id, relationship_type FROM relationships WHERE source_id = ? AND relationship_type = 'PARAM_TYPE'`).get(processSym.id) as { target_id: number; relationship_type: string } | undefined;
    assert.ok(paramRel, "Relasi PARAM_TYPE harus tercatat di database");

    // Periksa relasi CALLS: harus mengarah ke User.save (user.ts), bukan Other.save (other.ts)!
    const callRel = db.prepare(`SELECT target_id, confidence, evidence FROM relationships WHERE source_id = ? AND relationship_type = 'CALLS'`).get(processSym.id) as { target_id: number; confidence: number; evidence: string } | undefined;

    assert.ok(callRel, "Relasi CALLS harus terbentuk");
    assert.equal(callRel.target_id, userSaveSym.id, "CALLS harus mengarah ke User.save, bukan Other.save");
    assert.notEqual(callRel.target_id, otherSaveSym.id, "CALLS tidak boleh salah mengarah ke Other.save");
    assert.ok(callRel.confidence >= 0.9, "Confidence resolusi bertipe harus tinggi (>= 0.9)");
    assert.equal(callRel.evidence, "EXTRACTED");
  } finally {
    try { db.close(); } catch {}
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
});

test("Inheritance method dispatch: pemanggilan method terwarisi teresolusi ke class induk", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "scopecairn-inherit-res-"));
  const db = openDb(tmpDir);
  try {
    const f1 = db.prepare(`INSERT INTO files(path, language, hash, size) VALUES ('src/base.ts', 'typescript', 'h1', 100)`).run();
    const f2 = db.prepare(`INSERT INTO files(path, language, hash, size) VALUES ('src/entity.ts', 'typescript', 'h2', 100)`).run();
    const f3 = db.prepare(`INSERT INTO files(path, language, hash, size) VALUES ('src/app.ts', 'typescript', 'h3', 100)`).run();
    const fileIdBase = Number(f1.lastInsertRowid);
    const fileIdEntity = Number(f2.lastInsertRowid);
    const fileIdApp = Number(f3.lastInsertRowid);

    const baseContent = `export class BaseEntity {\n  persist() { return true; }\n}`;
    const baseExt = indexFileSymbols(db, fileIdBase, "src/base.ts", baseContent);
    indexFileRelations(db, fileIdBase, "src/base.ts", baseExt.extraction, baseExt.fileSym);

    const entityContent = `import { BaseEntity } from "./base";\nexport class Product extends BaseEntity {}`;
    const entityExt = indexFileSymbols(db, fileIdEntity, "src/entity.ts", entityContent);
    indexFileRelations(db, fileIdEntity, "src/entity.ts", entityExt.extraction, entityExt.fileSym);

    const appContent = `import { Product } from "./entity";\nexport function handle(p: Product) {\n  p.persist();\n}`;
    const appExt = indexFileSymbols(db, fileIdApp, "src/app.ts", appContent);
    indexFileRelations(db, fileIdApp, "src/app.ts", appExt.extraction, appExt.fileSym);

    const persistSym = db.prepare(`SELECT id FROM symbols WHERE file_id = ? AND name = 'persist'`).get(fileIdBase) as { id: number };
    const handleSym = db.prepare(`SELECT id FROM symbols WHERE file_id = ? AND name = 'handle'`).get(fileIdApp) as { id: number };

    const callRel = db.prepare(`SELECT target_id, confidence, evidence FROM relationships WHERE source_id = ? AND relationship_type = 'CALLS'`).get(handleSym.id) as { target_id: number; confidence: number; evidence: string } | undefined;

    assert.ok(callRel, "Relasi CALLS ke inherited method harus terbentuk");
    assert.equal(callRel.target_id, persistSym.id, "CALLS harus mengarah ke persist di BaseEntity");
    assert.ok(callRel.confidence >= 0.85);
  } finally {
    try { db.close(); } catch {}
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
});

test("Python type hints diekstrak sebagai PARAM_TYPE dan RETURN_TYPE", () => {
  const code = `
def process_order(order: Order, count: int) -> OrderResult:
    pass
`;
  const result = extractFile("src/order.py", code);
  const paramRel = result.relations.find((r) => r.from === "process_order" && r.to === "Order" && r.rel === "PARAM_TYPE");
  const retRel = result.relations.find((r) => r.from === "process_order" && r.to === "OrderResult" && r.rel === "RETURN_TYPE");

  assert.ok(paramRel, "Relasi PARAM_TYPE untuk Order di Python harus terbentuk");
  assert.ok(retRel, "Relasi RETURN_TYPE untuk OrderResult di Python harus terbentuk");
});
