// Test context knowledge agent: envelope --json kanonik, routing mode, dan
// output --knowledge untuk task SIMPLE (F1/F2 + perbaikan knowledge agent).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  buildContext,
  buildContextPayload,
  resolveEffectiveMode,
} from "../src/retrieval/contextBuilder.js";
import { execFileSync } from "node:child_process";
import { scanRepository } from "../src/scanner.js";
import { PRUNE_SECTIONS, cmdContext, packContextToTokenBudget } from "../src/commands/context.js";
import { installPreCommitHook, uninstallPreCommitHook } from "../src/commands/init.js";
import { DEFAULT_CONFIG } from "../src/retrieval/config.js";

function memDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE files (id INTEGER PRIMARY KEY, path TEXT UNIQUE, language TEXT, hash TEXT, size INTEGER);
    CREATE TABLE symbols (id INTEGER PRIMARY KEY, file_id INTEGER, name TEXT, type TEXT, signature TEXT, start_line INTEGER, end_line INTEGER);
    CREATE TABLE relationships (source_id INTEGER, target_id INTEGER, relationship_type TEXT, weight REAL, confidence REAL, evidence TEXT);
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `);
  return db;
}

const SIMPLE_CLS = {
  complexity: "SIMPLE" as const,
  estimatedFiles: 1,
  modules: ["src"],
  reasons: ["<3 file, 1 modul"],
  highFanin: [] as string[],
  protectedHits: [] as string[],
};

const COMPLEX_CLS = {
  ...SIMPLE_CLS,
  complexity: "COMPLEX" as const,
  estimatedFiles: 4,
  reasons: ["4 file"],
};

const sym = (id: number, name: string, file: string, score: number) => ({
  id,
  name,
  type: "function",
  file,
  signature: "",
  score,
  parts: { seed: score, proximity: 0, centrality: 0, recency: 0, cochange: 0 },
  reason: "seed",
});

const RESULT = {
  tokens: ["t"],
  seeds: [1],
  ranked: [sym(1, "buildContext", "src/a.ts", 0.6), sym(2, "mdKnowledge", "src/a.ts", 0.2)],
  config: DEFAULT_CONFIG,
  gitAvailable: false,
};

test("envelope --json memakai key yang sama di jalur ranked dan jalur kosong", () => {
  const db = memDb();
  try {
    const built = buildContext(db, "t", RESULT, COMPLEX_CLS, { repoRoot: "." });
    const ranked = buildContextPayload({
      task: "t",
      cls: COMPLEX_CLS,
      mode: "NORMAL",
      built,
      ranked: RESULT.ranked,
      analogs: [],
    });
    const empty = buildContextPayload({
      task: "t",
      cls: SIMPLE_CLS,
      mode: "FAST",
      empty: true,
      reason: "no_symbols",
    });
    assert.deepEqual(Object.keys(ranked).sort(), Object.keys(empty).sort());
    // Semua key kontrak selalu ada — konsumen machine tak perlu cabang.
    for (const key of [
      "task", "complexity", "mode", "knowledge", "empty", "reason",
      "high", "medium", "tests", "dependencies", "symbols", "hotspots", "analogs",
    ]) {
      assert.ok(key in ranked, `key ${key} hilang di jalur ranked`);
      assert.ok(key in empty, `key ${key} hilang di jalur kosong`);
    }
    assert.equal(ranked.empty, false);
    assert.equal(ranked.reason, null);
    assert.equal(empty.empty, true);
    assert.equal(empty.reason, "no_symbols");
    assert.equal(ranked.symbols.length, 2);
    assert.equal(empty.symbols.length, 0);
  } finally {
    db.close();
  }
});

test("related tests mengikuti arah edge TESTS (test -> file yang diuji)", () => {
  const db = memDb();
  db.exec(`
    INSERT INTO files (id, path, language, hash, size) VALUES
      (1, 'src/alpha.ts', 'typescript', 'h', 1),
      (2, 'tests/alpha.test.ts', 'typescript', 'h', 1);
    INSERT INTO symbols (id, file_id, name, type, signature, start_line, end_line) VALUES
      (1, 1, 'alpha', 'file', '', 1, 1),
      (2, 2, 'alpha.test', 'file', '', 1, 1);
    INSERT INTO relationships (source_id, target_id, relationship_type, weight, confidence, evidence)
      VALUES (2, 1, 'TESTS', 0.9, 0.8, 'INFERRED');
  `);
  try {
    const result = { ...RESULT, ranked: [sym(1, "alpha", "src/alpha.ts", 0.6)] };
    const built = buildContext(db, "ubah alpha", result, COMPLEX_CLS, { repoRoot: "." });
    assert.ok(
      built.tests.includes("tests/alpha.test.ts"),
      `test yang menguji file HIGH harus masuk related tests, dapat: ${JSON.stringify(built.tests)}`
    );
    // Sisi target edge bukan test: file sumber tidak boleh dilaporkan sebagai test.
    assert.ok(!built.tests.includes("src/alpha.ts"));
  } finally {
    db.close();
  }
});

test("resolveEffectiveMode: knowledge tidak pernah di-downgrade ke FAST implisit", () => {
  assert.equal(resolveEffectiveMode("NORMAL", SIMPLE_CLS, false), "FAST");
  assert.equal(resolveEffectiveMode("NORMAL", SIMPLE_CLS, true), "NORMAL");
  assert.equal(resolveEffectiveMode("NORMAL", COMPLEX_CLS, false), "NORMAL");
  // Pilihan eksplisit user selalu menang.
  assert.equal(resolveEffectiveMode("FAST", SIMPLE_CLS, true), "FAST");
  assert.equal(resolveEffectiveMode("SAFE", SIMPLE_CLS, false), "SAFE");
  assert.equal(resolveEffectiveMode("AUDIT", SIMPLE_CLS, true), "AUDIT");
});

test("--knowledge pada task SIMPLE menghasilkan output knowledge, bukan pesan kosong", () => {
  const db = memDb();
  try {
    const built = buildContext(db, "apa itu buildContext", RESULT, SIMPLE_CLS, {
      repoRoot: ".",
      knowledge: true,
    });
    assert.ok(built.markdown.startsWith("# Task Context (Knowledge)"));
    assert.ok(built.markdown.includes("## Ringkasan"));
    assert.ok(built.markdown.includes("## Cara pakai"));
    assert.ok(built.markdown.includes("## Kenapa (impor/call antar file relevan)"));
    assert.ok(built.markdown.includes("buildContext"));
    // Tanpa Scope/Guard coding — mode knowledge read-only.
    assert.ok(!built.markdown.includes("## Task Guard"));
    assert.ok(!built.markdown.includes("## Scope\n"));
    assert.ok(!built.markdown.includes("## Relevant Files"));
    // Heading lama yang menyesatkan ("trace 2-hop") tidak boleh kembali.
    assert.ok(!built.markdown.includes("trace 2-hop"));
  } finally {
    db.close();
  }
});

test("task SIMPLE tanpa --knowledge tetap memakai output lama (byte-regresi)", () => {
  const db = memDb();
  try {
    const built = buildContext(db, "t", RESULT, SIMPLE_CLS, { repoRoot: "." });
    assert.equal(
      built.markdown,
      `# Task Context\n\n## Task\nt\n\n## Complexity\n` +
        `SIMPLE (<3 file, 1 modul)\n\n` +
        `Task sederhana. Gunakan pencarian langsung. Kandidat: \`src/a.ts\`\n`
    );
  } finally {
    db.close();
  }
});

test("setiap seksi PRUNE_SECTIONS benar-benar dirender (drift heading = prune bisu)", () => {
  const db = memDb();
  try {
    // Heading lama yang menyesatkan tidak boleh kembali.
    assert.ok(!(PRUNE_SECTIONS as readonly string[]).includes("Kenapa (trace 2-hop)"));
    db.exec(
      `CREATE TABLE node_metrics (node_id INTEGER PRIMARY KEY, pagerank REAL, betweenness REAL, in_degree INTEGER, out_degree INTEGER);`
    );
    db.prepare(`INSERT INTO node_metrics(node_id, pagerank) VALUES (?, ?)`).run(1, 0.5);
    db.exec(`CREATE TABLE cycles (hash TEXT, length INTEGER, nodes_json TEXT);`);
    db.prepare(`INSERT INTO cycles(hash, length, nodes_json) VALUES (?, ?, ?)`).run(
      "h",
      1,
      JSON.stringify([1])
    );
    const analogs = [
      {
        sha: "aaa1111",
        shortSha: "aaa1111",
        ts: 1,
        date: "2026-10-01",
        subject: "feat: x",
        files: ["src/a.ts"],
        score: 0.5,
      },
    ];
    const opts = {
      repoRoot: ".",
      projectRules: { path: "AGENTS.md", content: "- aturan", truncated: false },
      history: { analogs },
    };
    const resWithVerified = {
      ...RESULT,
      verifiedAnalogs: [{ description: "x", files: ["src/a.ts"], verifiedAt: "2026-10-01", score: 1.0 }],
    };
    const know = buildContext(db, "t", resWithVerified, COMPLEX_CLS, { ...opts, knowledge: true });
    const full = buildContext(db, "t", resWithVerified, COMPLEX_CLS, opts);
    for (const sec of PRUNE_SECTIONS) {
      assert.ok(
        know.markdown.includes(`## ${sec}`) || full.markdown.includes(`## ${sec}`),
        `seksi "${sec}" tidak ditemukan di output mana pun — --max-tokens akan bisu`
      );
    }
  } finally {
    db.close();
  }
});

test("hotspots tahan tanpa tabel node_metrics dan terisi bila ada", () => {
  const db = memDb();
  try {
    const noMetrics = buildContext(db, "t", RESULT, COMPLEX_CLS, { repoRoot: "." });
    assert.deepEqual(noMetrics.hotspots, []);
    assert.ok(!noMetrics.markdown.includes("Critical hotspots"));

    db.exec(
      `CREATE TABLE node_metrics (node_id INTEGER PRIMARY KEY, pagerank REAL, betweenness REAL, in_degree INTEGER, out_degree INTEGER)`
    );
    db.prepare(`INSERT INTO node_metrics(node_id, pagerank) VALUES (?, ?)`).run(1, 0.5);
    const withMetrics = buildContext(db, "t", RESULT, COMPLEX_CLS, { repoRoot: "." });
    // Top-5 simbol rank tertinggi; yang punya metrik membawa pagerank asli.
    assert.equal(withMetrics.hotspots.length, 2);
    assert.equal(withMetrics.hotspots[0].name, "buildContext");
    assert.equal(withMetrics.hotspots[0].pagerank, 0.5);
    assert.equal(withMetrics.hotspots[1].pagerank, 0);
    assert.ok(withMetrics.markdown.includes("[pr=0.5000]"));
    // Envelope JSON ikut membawa hotspots terstruktur.
    const payload = buildContextPayload({
      task: "t",
      cls: COMPLEX_CLS,
      mode: "NORMAL",
      built: withMetrics,
      ranked: RESULT.ranked,
    });
    assert.deepEqual(payload.hotspots, [
      { name: "buildContext", type: "function", file: "src/a.ts", pagerank: 0.5 },
      { name: "mdKnowledge", type: "function", file: "src/a.ts", pagerank: 0 },
    ]);
  } finally {
    db.close();
  }
});

test("context COMPLEX menyertakan line-range + signature simbol dan menyembunyikan Task Guard secara default", () => {
  const db = memDb();
  try {
    const richResult = {
      ...RESULT,
      ranked: [
        {
          ...sym(1, "buildContext", "src/a.ts", 0.75),
          startLine: 46,
          endLine: 402,
          signature: "export function buildContext(db: DatabaseSync, task: string): BuiltContext",
        },
      ],
    };
    const compact = buildContext(db, "t", richResult, COMPLEX_CLS, { repoRoot: "." });
    assert.ok(compact.markdown.includes("`src/a.ts:46-402`"));
    assert.ok(compact.markdown.includes("`export function buildContext(db: DatabaseSync, task: string): BuiltContext`"));
    assert.ok(!compact.markdown.includes("## Task Guard"));
    assert.ok(!compact.markdown.includes("## Definition of Done"));

    const withGuard = buildContext(db, "t", richResult, COMPLEX_CLS, { repoRoot: ".", withGuard: true });
    assert.ok(withGuard.markdown.includes("## Task Guard"));
    assert.ok(withGuard.markdown.includes("## Definition of Done"));
  } finally {
    db.close();
  }
});

test("context COMPLEX menyertakan inline callers (called-by) dan micro-excerpt otomatis untuk simbol HIGH", () => {
  const db = memDb();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sc-ctx-excerpt-"));
  try {
    fs.mkdirSync(path.join(tmp, "src"), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, "src", "calc.ts"),
      [
        "export function computeTax(amount: number): number {",
        "  const rate = 0.11;",
        "  return Math.round(amount * rate);",
        "}",
      ].join("\n")
    );
    db.exec(`
      INSERT INTO files (id, path, language, hash, size) VALUES
        (1, 'src/calc.ts', 'typescript', 'h1', 100),
        (2, 'src/checkout.ts', 'typescript', 'h2', 100);
      INSERT INTO symbols (id, file_id, name, type, signature, start_line, end_line) VALUES
        (1, 1, 'computeTax', 'function', 'export function computeTax(amount: number): number', 1, 4),
        (2, 2, 'runCheckout', 'function', 'export function runCheckout()', 12, 25);
      INSERT INTO relationships (source_id, target_id, relationship_type, weight, confidence, evidence) VALUES
        (2, 1, 'CALLS', 1.0, 1.0, 'EXTRACTED');
    `);
    const res = {
      ...RESULT,
      ranked: [
        {
          ...sym(1, "computeTax", "src/calc.ts", 0.85),
          startLine: 1,
          endLine: 4,
          signature: "export function computeTax(amount: number): number",
        },
      ],
    };
    const built = buildContext(db, "computeTax", res, COMPLEX_CLS, { repoRoot: tmp });
    assert.ok(built.markdown.includes("↳ called-by: runCheckout (`src/checkout.ts:12`)"));
    assert.ok(built.markdown.includes("## Key Excerpts"));
    assert.ok(built.markdown.includes("const rate = 0.11;"));

    const noBodies = buildContext(db, "computeTax", res, COMPLEX_CLS, { repoRoot: tmp, withBodies: false });
    assert.ok(!noBodies.markdown.includes("## Key Excerpts"));
  } finally {
    db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("installPreCommitHook dan uninstallPreCommitHook mengelola .git/hooks/pre-commit dengan aman", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sc-hook-"));
  try {
    // Tanpa .git → lewati dengan aman
    assert.ok(installPreCommitHook(tmp, "scopecairn").includes("skipped"));

    // Buat .git dan pasang hook baru
    fs.mkdirSync(path.join(tmp, ".git"), { recursive: true });
    const msg = installPreCommitHook(tmp, "scopecairn");
    assert.ok(msg.includes("installed"));
    const hookPath = path.join(tmp, ".git", "hooks", "pre-commit");
    assert.ok(fs.existsSync(hookPath));
    assert.ok(fs.readFileSync(hookPath, "utf8").includes("scopecairn verify --no-strict"));

    // Uninstall menghapus file bila hanya berisi hook ScopeCairn
    assert.equal(uninstallPreCommitHook(tmp), "Pre-commit hook removed");
    assert.ok(!fs.existsSync(hookPath));

    // Bila user sudah punya pre-commit sendiri, pertahankan isinya saat install & uninstall
    fs.writeFileSync(hookPath, "#!/bin/sh\necho 'user check'\n");
    installPreCommitHook(tmp, "npx scopecairn");
    const merged = fs.readFileSync(hookPath, "utf8");
    assert.ok(merged.includes("echo 'user check'"));
    assert.ok(merged.includes("npx scopecairn verify --no-strict"));

    assert.equal(uninstallPreCommitHook(tmp), "Pre-commit hook cleaned");
    const cleaned = fs.readFileSync(hookPath, "utf8");
    assert.ok(cleaned.includes("echo 'user check'"));
    assert.ok(!cleaned.includes("scopecairn verify"));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("packContextToTokenBudget memangkas micro-excerpt dan MEDIUM sebelum Key Symbols & Scope", () => {
  const sample = [
    "# Task Context",
    "",
    "## Task",
    "fix auth token verification",
    "",
    "## Complexity",
    "COMPLEX (3 file relevan)",
    "",
    "## Relevant Files",
    "### HIGH",
    "- src/auth/verify.ts",
    "### MEDIUM",
    "- src/low1.ts",
    "- src/low2.ts",
    "- src/low3.ts",
    "",
    "## Key Symbols",
    "- `verifyJwt` (`src/auth/verify.ts:10-40`) — `export function verifyJwt(token: string): boolean`",
    "- `decodePayload` (`src/auth/verify.ts:42-70`) — `export function decodePayload(raw: string): Record<string, unknown>`",
    "- `helperLow` (`src/low1.ts:1-10`) — `export function helperLow()`",
    "",
    "## Key Excerpts",
    "### verifyJwt (`src/auth/verify.ts:10-30`)",
    "```",
    "export function verifyJwt(token: string): boolean {",
    "  // " + "x".repeat(260),
    "  return true;",
    "}",
    "```",
    "### helperLow (`src/low1.ts:1-10`)",
    "```",
    "export function helperLow() {",
    "  // " + "y".repeat(260),
    "}",
    "```",
    "",
    "## Analogi riwayat",
    "- `abc1234` (2026-10-01): old auth fix " + "z".repeat(160),
    "",
    "## Scope",
    "- **Required**: src/auth/verify.ts",
  ].join("\n");

  const packed = packContextToTokenBudget(sample, 170);
  assert.ok(packed.includes("## Key Symbols"), "Key Symbols harus dipertahankan");
  assert.ok(packed.includes("verifyJwt"), "Signature simbol teratas harus dipertahankan");
  assert.ok(packed.includes("## Scope"), "Scope harus dipertahankan");
  assert.ok(!packed.includes("Analogi riwayat"), "Analogi riwayat harus dipangkas lebih dulu");
  assert.ok(!packed.includes("y".repeat(40)), "Excerpt berprioritas rendah harus dipangkas");
  assert.ok(packed.includes("## Note"));
});

test("cmdContext --from-diff mengambil perubahan git aktif sebagai seed otomatis tanpa argumen task", async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "sc-from-diff-"));
  const origLog = console.log;
  const origErr = console.error;
  const logs: string[] = [];
  try {
    execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "t@example.com"], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["config", "user.name", "Tester"], { cwd: repo, stdio: "ignore" });
    fs.mkdirSync(path.join(repo, "src"), { recursive: true });
    fs.writeFileSync(
      path.join(repo, "src", "billing.ts"),
      `export function calculateTotal(price: number): number {\n  return price;\n}\n`,
      "utf8"
    );
    fs.writeFileSync(
      path.join(repo, "src", "unrelated.ts"),
      `export function unusedUtil(): number {\n  return 0;\n}\n`,
      "utf8"
    );
    execFileSync("git", ["add", "."], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "init"], { cwd: repo, stdio: "ignore" });
    await scanRepository(repo);

    // Ubah src/billing.ts di working tree
    fs.writeFileSync(
      path.join(repo, "src", "billing.ts"),
      `export function calculateTotal(price: number, tax = 0.1): number {\n  return price * (1 + tax);\n}\n`,
      "utf8"
    );

    console.log = (...args: unknown[]) => logs.push(args.map(String).join(" "));
    console.error = () => {};
    await cmdContext(repo, "", { fromDiff: true, json: true });

    const payload = JSON.parse(logs.join("\n")) as {
      empty: boolean;
      task: string;
      symbols: Array<{ name: string; file: string }>;
    };
    assert.equal(payload.empty, false);
    assert.ok(payload.task.includes("src/billing.ts"));
    assert.ok(payload.symbols.some((s) => s.file === "src/billing.ts"));
  } finally {
    console.log = origLog;
    console.error = origErr;
    fs.rmSync(repo, { recursive: true, force: true });
  }
});
