import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { scanRepository } from "../src/scanner.js";
import { openDb } from "../src/db.js";
import { findDependencies } from "../src/commands/deps.js";
import { findDeadCode } from "../src/commands/dead.js";
import { cmdScan } from "../src/commands/scan.js";
import { cmdStatus } from "../src/commands/status.js";
import { discoverWorkspaces, loadTsConfigForFile, resolveTsPathCandidates } from "../src/workspace.js";
import { enrichRelationsWithLsp, resolveWithLsp, serverCommandForLanguage } from "../src/extract/lsp.js";
import { isWatchExcludedPath } from "../src/commands/watch.js";
import { refreshIndex } from "../src/refresh.js";

function createMonorepoFixture(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sc-monorepo-"));
  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({ name: "acme-root", private: true, workspaces: ["packages/*"] }, null, 2),
    "utf8"
  );
  fs.writeFileSync(
    path.join(dir, "tsconfig.json"),
    `// Konfigurasi TypeScript root\n{\n  "compilerOptions": {\n    "baseUrl": ".",\n    "paths": {\n      "@shared/*": ["packages/shared/src/*"],\n    },\n  },\n}\n`,
    "utf8"
  );

  // packages/shared
  fs.mkdirSync(path.join(dir, "packages", "shared", "src", "core"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "packages", "shared", "package.json"),
    JSON.stringify({
      name: "@acme/shared",
      version: "1.0.0",
      exports: { ".": "./dist/index.js" },
      dependencies: { zod: "^3.23.0", "unused-shared-pkg": "^1.0.0" },
    }),
    "utf8"
  );
  fs.writeFileSync(
    path.join(dir, "packages", "shared", "src", "core", "token.ts"),
    `import { z } from "zod";\nexport function verifyToken(raw: string): boolean {\n  return z.string().parse(raw).length > 0;\n}\n`,
    "utf8"
  );
  fs.writeFileSync(
    path.join(dir, "packages", "shared", "src", "core", "index.ts"),
    `export * from "./token.js";\n`,
    "utf8"
  );
  fs.writeFileSync(
    path.join(dir, "packages", "shared", "src", "index.ts"),
    `export * from "./core/index.js";\nexport function sharedEntry(): boolean { return true; }\n`,
    "utf8"
  );

  // packages/app
  fs.mkdirSync(path.join(dir, "packages", "app", "src"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "packages", "app", "package.json"),
    JSON.stringify({
      name: "@acme/app",
      version: "1.0.0",
      main: "dist/main.js",
      dependencies: { "@acme/shared": "workspace:*", "only-in-shared-not-app": "^1.0.0" },
    }),
    "utf8"
  );
  fs.writeFileSync(
    path.join(dir, "packages", "app", "src", "main.ts"),
    `import { verifyToken } from "@acme/shared";\nimport { verifyToken as v2 } from "@shared/core/index";\nexport function runApp(): boolean {\n  return verifyToken("abc") && v2("xyz");\n}\n`,
    "utf8"
  );

  return dir;
}

test("monorepo discovery, tsconfig paths, barrel multi-hop, deps, dan dead code bekerja terpadu", async () => {
  const repo = createMonorepoFixture();
  try {
    const workspaces = discoverWorkspaces(repo);
    assert.equal(workspaces.length, 2);
    assert.deepEqual(
      workspaces.map((w) => w.dir),
      ["packages/app", "packages/shared"]
    );

    const tsCfg = loadTsConfigForFile(repo, "packages/app/src/main.ts");
    assert.ok(tsCfg);
    assert.deepEqual(resolveTsPathCandidates(tsCfg, "@shared/core/index"), [
      "packages/shared/src/core/index",
      "packages/app/src/main.ts".startsWith("x") ? "" : "@shared/core/index",
    ].filter(Boolean));

    await scanRepository(repo);
    const db = openDb(repo);
    try {
      // Cek edge CALLS dari runApp ke verifyToken melalui workspace import + 2-hop barrel
      const calls = db
        .prepare(
          `SELECT s.name AS src, t.name AS dst, r.evidence AS ev
           FROM relationships r
           JOIN symbols s ON s.id = r.source_id
           JOIN symbols t ON t.id = r.target_id
           WHERE r.relationship_type = 'CALLS' AND s.name = 'runApp' AND t.name = 'verifyToken'`
        )
        .all() as { src: string; dst: string; ev: string }[];
      assert.ok(calls.length >= 1, "runApp -> verifyToken harus ter-resolve");
      assert.ok(
        calls.some((c) => c.ev === "EXTRACTED"),
        "CALLS lintas workspace/barrel harus berstatus EXTRACTED"
      );

      // deps per workspace package
      const depsRes = findDependencies(db, repo);
      assert.ok(depsRes.manifests.includes("packages/shared/package.json"));
      assert.ok(depsRes.manifests.includes("packages/app/package.json"));
      const zodDep = depsRes.deps.find((d) => d.name === "zod" && d.package === "packages/shared");
      assert.equal(zodDep?.used, true);
      const unusedShared = depsRes.deps.find(
        (d) => d.name === "unused-shared-pkg" && d.package === "packages/shared"
      );
      assert.equal(unusedShared?.used, false);

      // dead code: entrypoint workspace exports/main tidak boleh ditandai dead
      const deadRes = findDeadCode(db, repo);
      const deadNames = new Set(deadRes.findings.map((f) => f.name));
      assert.ok(!deadNames.has("sharedEntry"), "workspace exports entrypoint tidak boleh dead");
      assert.ok(!deadNames.has("runApp"), "workspace main entrypoint tidak boleh dead");
    } finally {
      db.close();
    }
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("LspStdioClient, resolveWithLsp, dan enrichRelationsWithLsp bekerja melalui protokol JSON-RPC Content-Length", async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "sc-lsp-mock-"));
  try {
    fs.mkdirSync(path.join(repo, "src"), { recursive: true });
    const targetAbs = path.join(repo, "src", "provider.ts");
    fs.writeFileSync(
      targetAbs,
      `export function computeSpecial(): number {\n  return 42;\n}\n`,
      "utf8"
    );
    fs.writeFileSync(
      path.join(repo, "src", "duplicate.ts"),
      `export function computeSpecial(): number {\n  return 0;\n}\n`,
      "utf8"
    );
    const callerAbs = path.join(repo, "src", "consumer.ts");
    fs.writeFileSync(
      callerAbs,
      `export function runConsumer(): number {\n  return computeSpecial();\n}\n`,
      "utf8"
    );

    // Mock LSP server berbicara JSON-RPC Content-Length stdio
    const mockServerPath = path.join(repo, "mock-lsp.mjs");
    const targetUri = new URL(`file:///${targetAbs.replace(/\\/g, "/")}`).href;
    fs.writeFileSync(
      mockServerPath,
      [
        `let buf = Buffer.alloc(0);`,
        `function send(obj) {`,
        `  const s = JSON.stringify(obj);`,
        `  process.stdout.write("Content-Length: " + Buffer.byteLength(s, "utf8") + "\\r\\n\\r\\n" + s);`,
        `}`,
        `process.stdin.on("data", (chunk) => {`,
        `  buf = Buffer.concat([buf, chunk]);`,
        `  while (true) {`,
        `    const idx = buf.indexOf("\\r\\n\\r\\n");`,
        `    if (idx === -1) break;`,
        `    const hdr = buf.slice(0, idx).toString("ascii");`,
        `    const m = /Content-Length:\\s*(\\d+)/i.exec(hdr);`,
        `    if (!m) { buf = buf.slice(idx + 4); continue; }`,
        `    const len = parseInt(m[1], 10);`,
        `    if (buf.length < idx + 4 + len) break;`,
        `    const msg = JSON.parse(buf.slice(idx + 4, idx + 4 + len).toString("utf8"));`,
        `    buf = buf.slice(idx + 4 + len);`,
        `    if (msg.method === "initialize") send({ jsonrpc: "2.0", id: msg.id, result: { capabilities: {} } });`,
        `    else if (msg.method === "textDocument/definition") send({ jsonrpc: "2.0", id: msg.id, result: [{ uri: ${JSON.stringify(targetUri)}, range: { start: { line: 0, character: 16 }, end: { line: 0, character: 30 } } }] });`,
        `    else if (msg.method === "shutdown") send({ jsonrpc: "2.0", id: msg.id, result: null });`,
        `    else if (msg.method === "exit") process.exit(0);`,
        `  }`,
        `});`,
      ].join("\n"),
      "utf8"
    );

    const mockCmd = { command: process.execPath, args: [mockServerPath], languageId: "typescript" };
    const resolved = await resolveWithLsp("src/consumer.ts", "computeSpecial", undefined, repo, mockCmd);
    assert.equal(resolved, "src/provider.ts:1");

    await scanRepository(repo);
    const db = openDb(repo);
    try {
      // Pastikan ada CALLS AMBIGUOUS sebelum enrichment (karena tidak ada import)
      const fileRow = db.prepare(`SELECT id FROM files WHERE path = 'src/consumer.ts'`).get() as { id: number };
      // Paksa target awal ke duplicate.ts + AMBIGUOUS untuk membuktikan LSP mengarahkan ke provider.ts
      const dupSym = db
        .prepare(`SELECT s.id FROM symbols s JOIN files f ON f.id = s.file_id WHERE f.path = 'src/duplicate.ts' AND s.name = 'computeSpecial'`)
        .get() as { id: number };
      const provSym = db
        .prepare(`SELECT s.id FROM symbols s JOIN files f ON f.id = s.file_id WHERE f.path = 'src/provider.ts' AND s.name = 'computeSpecial'`)
        .get() as { id: number };
      db.prepare(
        `UPDATE relationships SET target_id = ?, confidence = 0.3, evidence = 'AMBIGUOUS'
         WHERE source_id IN (SELECT id FROM symbols WHERE file_id = ?) AND relationship_type = 'CALLS'`
      ).run(dupSym.id, fileRow.id);

      const upgraded = await enrichRelationsWithLsp(
        db,
        repo,
        [
          {
            fileId: fileRow.id,
            rel: "src/consumer.ts",
            content: fs.readFileSync(callerAbs, "utf8"),
            language: "typescript",
          },
        ],
        { tsserver: null, gopls: null, pyright: null },
        { typescript: mockCmd }
      );
      assert.equal(upgraded, 1);

      const relRow = db
        .prepare(
          `SELECT target_id, confidence, evidence FROM relationships
           WHERE source_id IN (SELECT id FROM symbols WHERE file_id = ?) AND relationship_type = 'CALLS'`
        )
        .get(fileRow.id) as { target_id: number; confidence: number; evidence: string };
      assert.equal(relRow.target_id, provSym.id);
      assert.equal(relRow.evidence, "EXTRACTED");
      assert.equal(relRow.confidence, 0.98);
    } finally {
      db.close();
    }
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("cmdScan --json dan cmdStatus --json menghasilkan JSON terstruktur yang valid", async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "sc-json-cmds-"));
  const origLog = console.log;
  const logs: string[] = [];
  try {
    fs.mkdirSync(path.join(repo, "src"), { recursive: true });
    fs.writeFileSync(path.join(repo, "src", "hello.ts"), `export function hi(): string { return "ok"; }\n`, "utf8");

    console.log = (...args: unknown[]) => logs.push(args.map(String).join(" "));
    await cmdScan(repo, { json: true });
    const scanOut = JSON.parse(logs.join("\n"));
    assert.equal(scanOut.sourceFiles, 1);
    assert.ok(scanOut.symbols >= 1);

    logs.length = 0;
    await cmdStatus(repo, { json: true });
    const statusOut = JSON.parse(logs.join("\n"));
    assert.equal(statusOut.initialized, true);
    assert.equal(statusOut.files, 1);
    assert.ok(statusOut.symbols >= 1);
  } finally {
    console.log = origLog;
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("isWatchExcludedPath menyaring folder build/deps di subpaket monorepo dan refreshIndex changedPaths bekerja inkremental", async () => {
  assert.equal(isWatchExcludedPath("node_modules/pkg/index.js"), true);
  assert.equal(isWatchExcludedPath("apps/web/node_modules/react/index.js"), true);
  assert.equal(isWatchExcludedPath("packages/ui/.next/server/app.js"), true);
  assert.equal(isWatchExcludedPath("services/api/dist/main.js"), true);
  assert.equal(isWatchExcludedPath("apps/web/src/page.tsx"), false);

  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "sc-watch-inc-"));
  try {
    fs.mkdirSync(path.join(repo, "src"), { recursive: true });
    fs.writeFileSync(path.join(repo, "src", "keep.ts"), `export function keepFn(): number { return 1; }\n`, "utf8");
    fs.writeFileSync(path.join(repo, "src", "edit.ts"), `export function oldFn(): number { return 2; }\n`, "utf8");
    await scanRepository(repo);

    // Tambah file baru, ubah edit.ts, hapus keep.ts
    fs.writeFileSync(path.join(repo, "src", "added.ts"), `export function newFn(): number { return 3; }\n`, "utf8");
    fs.writeFileSync(path.join(repo, "src", "edit.ts"), `export function updatedFn(): number { return 4; }\n`, "utf8");
    fs.rmSync(path.join(repo, "src", "keep.ts"));

    const res = await refreshIndex(repo, {
      changedPaths: ["src/added.ts", "src/edit.ts", "src/keep.ts"],
    });
    assert.equal(res.stats.inserted, 1);
    assert.equal(res.stats.updated, 1);
    assert.equal(res.stats.removed, 1);

    const db = openDb(repo);
    try {
      const paths = (db.prepare(`SELECT path FROM files ORDER BY path`).all() as { path: string }[]).map((r) => r.path);
      assert.deepEqual(paths, ["src/added.ts", "src/edit.ts"]);
    } finally {
      db.close();
    }
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("Python monorepo ([tool.uv.workspace]) ditemukan oleh discoverWorkspaces dan dipindai deps per paket", async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "sc-py-monorepo-"));
  try {
    fs.writeFileSync(
      path.join(repo, "pyproject.toml"),
      `[project]\nname = "py-root"\ndependencies = ["httpx>=0.27"]\n\n[tool.uv.workspace]\nmembers = ["services/*"]\nexclude = ["services/ignored"]\n`,
      "utf8"
    );
    fs.mkdirSync(path.join(repo, "services", "billing"), { recursive: true });
    fs.writeFileSync(
      path.join(repo, "services", "billing", "pyproject.toml"),
      `[project]\nname = "billing"\ndependencies = ["pydantic>=2.0", "unused-ml-lib>=1.0"]\n`,
      "utf8"
    );
    fs.writeFileSync(
      path.join(repo, "services", "billing", "app.py"),
      `from pydantic import BaseModel\nclass Invoice(BaseModel):\n    total: int\n`,
      "utf8"
    );
    fs.mkdirSync(path.join(repo, "services", "ignored"), { recursive: true });
    fs.writeFileSync(
      path.join(repo, "services", "ignored", "pyproject.toml"),
      `[project]\nname = "ignored"\ndependencies = ["requests"]\n`,
      "utf8"
    );

    const workspaces = discoverWorkspaces(repo);
    assert.equal(workspaces.length, 1);
    assert.equal(workspaces[0].ecosystem, "python");
    assert.equal(workspaces[0].dir, "services/billing");

    await scanRepository(repo);
    const db = openDb(repo);
    try {
      const depsRes = findDependencies(db, repo);
      assert.ok(depsRes.manifests.includes("pyproject.toml"));
      assert.ok(depsRes.manifests.includes("services/billing/pyproject.toml"));
      assert.ok(!depsRes.manifests.includes("services/ignored/pyproject.toml"));

      const pydanticDep = depsRes.deps.find(
        (d) => d.name === "pydantic" && d.package === "services/billing"
      );
      assert.equal(pydanticDep?.used, true);

      const unusedDep = depsRes.deps.find(
        (d) => d.name === "unused-ml-lib" && d.package === "services/billing"
      );
      assert.equal(unusedDep?.used, false);
    } finally {
      db.close();
    }
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("LSP mendukung rust-analyzer dan fallback textDocument/typeDefinition untuk IMPLEMENTS/USES", async () => {
  const rustSrv = serverCommandForLanguage("rust", {
    tsserver: null,
    gopls: null,
    pyright: null,
    rustAnalyzer: "/usr/bin/rust-analyzer",
  });
  assert.deepEqual(rustSrv, {
    command: "/usr/bin/rust-analyzer",
    args: [],
    languageId: "rust",
  });

  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "sc-lsp-types-"));
  try {
    fs.mkdirSync(path.join(repo, "src"), { recursive: true });
    const traitAbs = path.join(repo, "src", "iface.ts");
    fs.writeFileSync(traitAbs, `export interface Runner {\n  run(): void;\n}\n`, "utf8");
    fs.writeFileSync(path.join(repo, "src", "other.ts"), `export interface Runner {\n  run(): void;\n}\n`, "utf8");
    const implAbs = path.join(repo, "src", "worker.ts");
    fs.writeFileSync(implAbs, `export class Worker implements Runner {\n  run(): void {}\n}\n`, "utf8");

    const mockServerPath = path.join(repo, "mock-type-lsp.mjs");
    const traitUri = new URL(`file:///${traitAbs.replace(/\\/g, "/")}`).href;
    fs.writeFileSync(
      mockServerPath,
      [
        `let buf = Buffer.alloc(0);`,
        `function send(obj) {`,
        `  const s = JSON.stringify(obj);`,
        `  process.stdout.write("Content-Length: " + Buffer.byteLength(s, "utf8") + "\\r\\n\\r\\n" + s);`,
        `}`,
        `process.stdin.on("data", (chunk) => {`,
        `  buf = Buffer.concat([buf, chunk]);`,
        `  while (true) {`,
        `    const idx = buf.indexOf("\\r\\n\\r\\n");`,
        `    if (idx === -1) break;`,
        `    const hdr = buf.slice(0, idx).toString("ascii");`,
        `    const m = /Content-Length:\\s*(\\d+)/i.exec(hdr);`,
        `    if (!m) { buf = buf.slice(idx + 4); continue; }`,
        `    const len = parseInt(m[1], 10);`,
        `    if (buf.length < idx + 4 + len) break;`,
        `    const msg = JSON.parse(buf.slice(idx + 4, idx + 4 + len).toString("utf8"));`,
        `    buf = buf.slice(idx + 4 + len);`,
        `    if (msg.method === "initialize") send({ jsonrpc: "2.0", id: msg.id, result: { capabilities: {} } });`,
        `    else if (msg.method === "textDocument/definition") send({ jsonrpc: "2.0", id: msg.id, result: [] });`,
        `    else if (msg.method === "textDocument/typeDefinition") send({ jsonrpc: "2.0", id: msg.id, result: [{ uri: ${JSON.stringify(traitUri)}, range: { start: { line: 0, character: 17 }, end: { line: 0, character: 23 } } }] });`,
        `    else if (msg.method === "shutdown") send({ jsonrpc: "2.0", id: msg.id, result: null });`,
        `    else if (msg.method === "exit") process.exit(0);`,
        `  }`,
        `});`,
      ].join("\n"),
      "utf8"
    );

    await scanRepository(repo);
    const db = openDb(repo);
    try {
      const workerFile = db.prepare(`SELECT id FROM files WHERE path = 'src/worker.ts'`).get() as { id: number };
      const otherSym = db
        .prepare(`SELECT s.id FROM symbols s JOIN files f ON f.id = s.file_id WHERE f.path = 'src/other.ts' AND s.name = 'Runner'`)
        .get() as { id: number };
      const ifaceSym = db
        .prepare(`SELECT s.id FROM symbols s JOIN files f ON f.id = s.file_id WHERE f.path = 'src/iface.ts' AND s.name = 'Runner'`)
        .get() as { id: number };
      const workerSym = db
        .prepare(`SELECT id FROM symbols WHERE file_id = ? AND name = 'Worker'`)
        .get(workerFile.id) as { id: number };
      db.prepare(
        `INSERT INTO relationships(source_id, target_id, relationship_type, weight, confidence, evidence)
         VALUES (?, ?, 'IMPLEMENTS', 0.8, 0.5, 'AMBIGUOUS')`
      ).run(workerSym.id, otherSym.id);

      const mockCmd = { command: process.execPath, args: [mockServerPath], languageId: "typescript" };
      const upgraded = await enrichRelationsWithLsp(
        db,
        repo,
        [
          {
            fileId: workerFile.id,
            rel: "src/worker.ts",
            content: fs.readFileSync(implAbs, "utf8"),
            language: "typescript",
          },
        ],
        { tsserver: null, gopls: null, pyright: null, rustAnalyzer: null },
        { typescript: mockCmd }
      );
      assert.ok(upgraded >= 1);
      const rel = db
        .prepare(
          `SELECT target_id, evidence FROM relationships
           WHERE source_id = ? AND relationship_type = 'IMPLEMENTS' ORDER BY id DESC LIMIT 1`
        )
        .get(workerSym.id) as { target_id: number; evidence: string };
      assert.equal(rel.target_id, ifaceSym.id);
      assert.equal(rel.evidence, "EXTRACTED");
    } finally {
      db.close();
    }
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});
