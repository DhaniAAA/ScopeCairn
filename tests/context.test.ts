// Test context knowledge agent: envelope --json kanonik, routing mode, dan
// output --knowledge untuk task SIMPLE (F1/F2 + perbaikan knowledge agent).
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  buildContext,
  buildContextPayload,
  resolveEffectiveMode,
} from "../src/retrieval/contextBuilder.js";
import { PRUNE_SECTIONS } from "../src/commands/context.js";
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
    const know = buildContext(db, "t", RESULT, COMPLEX_CLS, { ...opts, knowledge: true });
    const full = buildContext(db, "t", RESULT, COMPLEX_CLS, opts);
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
