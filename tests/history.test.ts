// Test Analogi Riwayat: deterministik, in-memory, tanpa git.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  parseGitLog,
  isHistorySkipped,
  shouldSkipCommit,
} from "../src/retrieval/history/extractor.js";
import {
  stripConventionalPrefix,
  isPoorSubject,
  commitTokens,
  syncCommitFts,
} from "../src/retrieval/history/index.js";
import {
  historySearch,
  coChangeSet,
  groupHistoryFiles,
  resolveCurrentPath,
  leaveOneOut,
} from "../src/retrieval/history/search.js";
import { buildGraphMd, exportJson } from "../src/graph/export.js";

const NOW = 1_750_000_000; // detik epoch tetap → deterministik

function memDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE files (id INTEGER PRIMARY KEY, path TEXT UNIQUE, language TEXT, hash TEXT, size INTEGER);
    CREATE TABLE symbols (id INTEGER PRIMARY KEY, file_id INTEGER, name TEXT, type TEXT, signature TEXT, start_line INTEGER, end_line INTEGER);
    CREATE TABLE relationships (source_id INTEGER, target_id INTEGER, relationship_type TEXT, weight REAL, confidence REAL, evidence TEXT);
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE commits (sha TEXT PRIMARY KEY, ts INTEGER, subject TEXT, body TEXT, author TEXT);
    CREATE INDEX idx_commits_ts ON commits(ts);
    CREATE TABLE commit_files (sha TEXT, path TEXT, status TEXT, old_path TEXT, additions INTEGER, deletions INTEGER);
    CREATE INDEX idx_commit_files_sha ON commit_files(sha);
    CREATE INDEX idx_commit_files_path ON commit_files(path);
    CREATE VIRTUAL TABLE commit_fts USING fts5(sha UNINDEXED, subject, body, paths);
  `);
  return db;
}

function addFile(db: DatabaseSync, id: number, path: string): void {
  db.prepare(`INSERT INTO files (id, path, language, hash, size) VALUES (?, ?, 'typescript', 'h', 1)`).run(id, path);
}

function addCommit(
  db: DatabaseSync,
  sha: string,
  ts: number,
  subject: string,
  files: { path: string; status?: string; oldPath?: string | null }[]
): void {
  db.prepare(`INSERT INTO commits (sha, ts, subject, body, author) VALUES (?, ?, ?, '', 'dev')`).run(sha, ts, subject);
  const ins = db.prepare(`INSERT INTO commit_files (sha, path, status, old_path, additions, deletions) VALUES (?, ?, ?, ?, 1, 0)`);
  for (const f of files) ins.run(sha, f.path, f.status ?? "M", f.oldPath ?? null);
}

function seedRepo(db: DatabaseSync): void {
  // Working tree saat ini.
  addFile(db, 1, "src/orders/cancel.ts");
  addFile(db, 2, "src/orders/refund.ts");
  addFile(db, 3, "tests/orders.test.ts");
  addFile(db, 4, "README.md");
  // Riwayat: analog cancel (lama) + refund (lebih baru) + noise update.
  addCommit(db, "aaa1111", NOW - 30 * 86400, "add endpoint cancel order", [
    { path: "src/orders/cancel.ts", status: "A" },
    { path: "tests/orders.test.ts", status: "A" },
  ]);
  addCommit(db, "bbb2222", NOW - 5 * 86400, "fix refund validation", [
    { path: "src/orders/refund.ts" },
    { path: "tests/orders.test.ts" },
  ]);
  addCommit(db, "ccc3333", NOW - 2 * 86400, "update", [{ path: "README.md" }]);
  syncCommitFts(db, ["aaa1111", "bbb2222", "ccc3333"]);
}

test("parseGitLog membaca header, numstat, dan rename", () => {
  const FS = String.fromCharCode(1);
  const RS = String.fromCharCode(30);
  const SB = String.fromCharCode(31);
  const out =
    `abc1234${FS}1700000000${FS}Jane${FS}add endpoint cancel order${SB}body here${RS}\n` +
    `A\t10\t5\tsrc/orders/cancel.ts\n` +
    `M\t3\t1\ttests/orders.test.ts\n` +
    `R100\told/path.ts\tnew/path.ts\n` +
    `10\t2\tnew/path.ts\n`;
  const commits = parseGitLog(out);
  assert.equal(commits.length, 1);
  assert.equal(commits[0].sha, "abc1234");
  assert.equal(commits[0].subject, "add endpoint cancel order");
  assert.equal(commits[0].body, "body here");
  const rename = commits[0].files.find((f) => f.status === "R");
  assert.deepEqual([rename?.path, rename?.oldPath], ["new/path.ts", "old/path.ts"]);
});

test("history skip: lockfile, generated, dan commit raksasa", () => {
  assert.equal(isHistorySkipped("package-lock.json"), true);
  assert.equal(isHistorySkipped("dist/bundle.min.js"), true);
  assert.equal(isHistorySkipped("src/orders/cancel.ts"), false);
  assert.equal(shouldSkipCommit(41), true);
  assert.equal(shouldSkipCommit(40), false);
});

test("tokenisasi commit: prefix dibuang, subject miskin via path", () => {
  assert.equal(stripConventionalPrefix("feat(api): add refund"), "add refund");
  assert.equal(stripConventionalPrefix("fix: correct total"), "correct total");
  assert.equal(isPoorSubject("update"), true);
  assert.equal(isPoorSubject("Merge PR #12"), true);
  assert.equal(isPoorSubject("add endpoint cancel order"), false);
  const toks = commitTokens("update", "", ["src/orders/cancel.ts"]);
  assert.ok(toks.includes("cancel") && toks.includes("orders"));
});

test("task refund mengembalikan analog cancel sebagai teratas", () => {
  const db = memDb();
  try {
    seedRepo(db);
    const analogs = historySearch(db, "add refund endpoint", { limit: 3, nowSec: NOW });
    assert.ok(analogs.length >= 1);
    assert.equal(analogs[0].subject, "add endpoint cancel order");
    assert.ok(analogs[0].files.includes("src/orders/cancel.ts"));
  } finally {
    db.close();
  }
});

test("co-change hanya berisi file yang masih ada; rename terpetakan", () => {
  const db = memDb();
  try {
    seedRepo(db);
    // Commit lama menunjuk path lawas yang di-rename ke path terkini.
    addFile(db, 5, "src/orders/charge.ts");
    addCommit(db, "ddd4444", NOW - 40 * 86400, "add endpoint charge order", [
      { path: "src/orders/legacy.ts", status: "R", oldPath: null },
    ]);
    db.prepare(`UPDATE commit_files SET old_path = 'src/orders/legacy.ts', path = 'src/orders/charge.ts' WHERE sha = 'ddd4444'`).run();
    // Simulasi rename lain: legacy.ts → charge.ts tercatat di commit terpisah.
    addCommit(db, "eee5555", NOW - 39 * 86400, "rename legacy to charge", [
      { path: "src/orders/charge.ts", status: "R", oldPath: "src/orders/legacy.ts" },
    ]);
    syncCommitFts(db, ["ddd4444", "eee5555"]);
    assert.equal(resolveCurrentPath(db, "src/orders/legacy.ts"), "src/orders/charge.ts");
    const analogs = historySearch(db, "add charge endpoint", { limit: 3, nowSec: NOW });
    for (const a of analogs) {
      for (const f of a.files) {
        const hit = db.prepare(`SELECT 1 AS ok FROM files WHERE path = ? LIMIT 1`).get(f) as { ok: number } | undefined;
        assert.ok(hit, `file analog harus masih ada: ${f}`);
      }
    }
    const co = coChangeSet(historySearch(db, "add endpoint order", { limit: 3, nowSec: NOW }));
    for (const c of co) {
      const hit = db.prepare(`SELECT 1 AS ok FROM files WHERE path = ? LIMIT 1`).get(c.path) as { ok: number } | undefined;
      assert.ok(hit);
    }
  } finally {
    db.close();
  }
});

test("commit raksasa tidak pernah jadi analog; tanpa ambang lolos seksi disembunyikan", () => {
  const db = memDb();
  try {
    seedRepo(db);
    const bigFiles = Array.from({ length: 45 }, (_, i) => ({ path: `src/gen/f${i}.ts`, status: "A" as const }));
    addCommit(db, "fff6666", NOW - 1 * 86400, "add endpoint order bulk import", bigFiles);
    syncCommitFts(db, ["fff6666"]);
    const analogs = historySearch(db, "add endpoint order", { limit: 5, nowSec: NOW });
    assert.ok(!analogs.some((a) => a.sha === "fff6666"));
    const none = historySearch(db, "zzzqqq tidak ada yang cocok", { limit: 3, nowSec: NOW });
    assert.deepEqual(none, []);
  } finally {
    db.close();
  }
});

test("pencarian deterministik untuk input dan state yang sama", () => {
  const db = memDb();
  try {
    seedRepo(db);
    const a = historySearch(db, "add refund endpoint", { limit: 3, nowSec: NOW });
    const b = historySearch(db, "add refund endpoint", { limit: 3, nowSec: NOW });
    assert.deepEqual(a, b);
  } finally {
    db.close();
  }
});

test("GRAPH.md dan export tidak memuat teks commit", () => {
  const db = memDb();
  try {
    seedRepo(db);
    addFile(db, 9, "src/x.ts");
    db.prepare(`INSERT INTO symbols (file_id, name, type, signature, start_line, end_line) VALUES (9, 'x', 'function', '', 1, 1)`).run();
    const md = buildGraphMd(db, ".");
    assert.ok(!md.includes("add endpoint cancel order"));
    assert.ok(!md.includes("aaa1111"));
    const json = exportJson(db);
    assert.ok(!json.includes("add endpoint cancel order"));
    assert.ok(!json.includes("aaa1111"));
  } finally {
    db.close();
  }
});

test("leave-one-out menyembunyikan target dan yang lebih baru", () => {
  const db = memDb();
  try {
    seedRepo(db);
    const rows = leaveOneOut(db, ["aaa1111", "bbb2222"], { limit: 3, nowSec: NOW });
    assert.equal(rows.length, 2);
    for (const r of rows) {
      assert.ok(r.expected.length > 0);
      assert.ok(r.recall >= 0 && r.recall <= 1);
    }
    // Target bbb2222 (lebih baru) tak boleh dipakai saat menilai aaa1111:
    // analog untuk aaa1111 hanya boleh dari commit lebih lama (tak ada) → recall 0.
    const first = rows.find((r) => r.sha === "aaa1111")!;
    assert.equal(first.recall, 0);
  } finally {
    db.close();
  }
});

test("grouping file analog: source, test, config, docs", () => {
  const g = groupHistoryFiles([
    "src/a.ts",
    "tests/a.test.ts",
    "package.json",
    "docs/guide.md",
  ]);
  assert.deepEqual(g, {
    source: ["src/a.ts"],
    test: ["tests/a.test.ts"],
    config: ["package.json"],
    docs: ["docs/guide.md"],
  });
});
