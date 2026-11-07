import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { openDb } from "../src/db.js";
import { indexFileSymbols, indexFileRelations } from "../src/indexer.js";
import { prepareTreeSitter } from "../src/treesitter.js";
import { recordVerifiedTask, findVerifiedAnalogs } from "../src/retrieval/verified.js";
import { retrieve } from "../src/retrieval/retrieve.js";
import { buildContext } from "../src/retrieval/contextBuilder.js";
import { classify } from "../src/retrieval/classify.js";
import { runVerify } from "../src/commands/verify.js";
import { persistScope } from "../src/scope/taskScope.js";
import { scanRepository } from "../src/scanner.js";

await prepareTreeSitter(["typescript"]);

function git(repo: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd: repo,
    encoding: "utf8",
    timeout: 15000,
    stdio: ["ignore", "pipe", "ignore"],
  });
}

function setupTestDb(tmpDir: string) {
  const db = openDb(tmpDir);
  const add = (p: string, src: string) => {
    const id = Number(
      db.prepare(`INSERT INTO files(path, language, hash, size) VALUES (?, 'typescript', 'h', 1)`).run(p)
        .lastInsertRowid
    );
    const ext = indexFileSymbols(db, id, p, src);
    indexFileRelations(db, id, p, ext.extraction, ext.fileSym);
    return id;
  };
  add("src/auth/jwt.ts", `export function validateJwt(token: string) { return token.length > 10; }`);
  add("src/auth/login.ts", `import { validateJwt } from "./jwt";\nexport function login(t: string) { return validateJwt(t); }`);
  add("src/billing/invoice.ts", `export function renderInvoice() { return "inv"; }`);
  return db;
}

test("recordVerifiedTask & findVerifiedAnalogs: roundtrip dan pencarian semantik kemiripan token", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "scopecairn-learn-"));
  const db = setupTestDb(tmp);
  try {
    const taskDesc = "perbaiki validasi jwt authentication";
    const files = ["src/auth/jwt.ts", "src/auth/login.ts"];

    recordVerifiedTask(db, taskDesc, files);

    // Exact match
    const exact = findVerifiedAnalogs(db, taskDesc);
    assert.equal(exact.length, 1);
    assert.equal(exact[0].description, taskDesc);
    assert.deepEqual(exact[0].files, files);
    assert.equal(exact[0].score, 1.0);

    // Similar query with different phrasing
    const similar = findVerifiedAnalogs(db, "jwt authentication token check");
    assert.ok(similar.length > 0, "harus menemukan analog berdasarkan kemiripan token");
    assert.deepEqual(similar[0].files, files);

    // Completely unrelated query
    const unrelated = findVerifiedAnalogs(db, "tambah template invoice billing");
    assert.equal(unrelated.length, 0, "query tidak terkait tidak boleh mencocokkan");

    // Idempotency / update
    recordVerifiedTask(db, taskDesc, ["src/auth/jwt.ts"]);
    const updated = findVerifiedAnalogs(db, taskDesc);
    assert.equal(updated.length, 1);
    assert.deepEqual(updated[0].files, ["src/auth/jwt.ts"], "re-verify harus memperbarui daftar file");
  } finally {
    db.close();
  }
});

test("retrieve & contextBuilder: task terverifikasi otomatis dipromosikan ke seeds, HIGH, dan Required scope", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "scopecairn-retrieve-learn-"));
  const db = setupTestDb(tmp);
  try {
    const priorTask = "perbaiki validasi jwt authentication";
    recordVerifiedTask(db, priorTask, ["src/auth/jwt.ts"]);

    // Query baru dengan kata yang mirip
    const newQuery = "authentication jwt";
    const result = retrieve(db, tmp, newQuery);

    assert.ok(result.verifiedAnalogs && result.verifiedAnalogs.length > 0, "verifiedAnalogs harus terisi");
    const jwtRank = result.ranked.find((r) => r.file === "src/auth/jwt.ts");
    assert.ok(jwtRank, "jwt.ts harus ada di ranked");
    assert.match(jwtRank.reason, /verified/, "reason harus menandai verified");

    // ContextBuilder dengan escalate untuk memeriksa seksi Analogi task terverifikasi
    const cls = classify(result.ranked, () => 0, 0.15, []);
    const ctx = buildContext(db, newQuery, result, cls, { repoRoot: tmp, escalate: true });

    assert.match(ctx.markdown, /## Analogi task terverifikasi/);
    assert.match(ctx.markdown, /src\/auth\/jwt\.ts/);
    assert.ok(ctx.scope.required.includes("src/auth/jwt.ts"), "file terverifikasi harus masuk Required scope");
  } finally {
    db.close();
  }
});

test("runVerify: mencatat task ke verified_tasks saat lolos verifikasi dengan --task", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sc-verify-learn-"));
  try {
    git(dir, ["init"]);
    git(dir, ["config", "user.email", "t@example.com"]);
    git(dir, ["config", "user.name", "Test"]);
    fs.mkdirSync(path.join(dir, "src"), { recursive: true });

    fs.writeFileSync(path.join(dir, ".gitignore"), ".scopecairn/\n");
    const jwtPath = path.join(dir, "src", "jwt.ts");
    fs.writeFileSync(jwtPath, `export function validateJwt(t: string): boolean {\n  return t.length > 5;\n}\n`);
    git(dir, ["add", "."]);
    git(dir, ["commit", "-m", "initial commit"]);

    await scanRepository(dir);

    const task = "perbaiki validasi jwt";
    const db = openDb(dir);
    try {
      const t = db.prepare(`INSERT INTO tasks(description, complexity) VALUES (?, 'SIMPLE')`).run(task);
      const taskId = Number(t.lastInsertRowid);
      persistScope(db, taskId, { required: ["src/jwt.ts"], optional: [], protected: [] });
    } finally {
      db.close();
    }

    // Ubah file in-scope
    fs.writeFileSync(jwtPath, `export function validateJwt(t: string): boolean {\n  return t.length > 10;\n}\n`);

    const res = await runVerify(dir, {
      task,
      strict: true,
      noRefresh: true,
    });

    assert.ok(res.ok, "verifikasi harus lulus");
    assert.equal(res.verifiedRecorded, true, "verifiedRecorded harus true");

    // Cek apakah tersimpan di SQLite verified_tasks
    const verifyDb = openDb(dir);
    try {
      const rows = verifyDb
        .prepare(`SELECT description, files_json FROM verified_tasks WHERE description = ?`)
        .all(task) as { description: string; files_json: string }[];
      assert.equal(rows.length, 1);
      const files = JSON.parse(rows[0].files_json) as string[];
      assert.ok(files.includes("src/jwt.ts"), "file yang diubah harus tercatat");
    } finally {
      verifyDb.close();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
