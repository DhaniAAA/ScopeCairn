import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadDecisions, appendDecision, listDecisions } from "../src/decisions.js";
import { lineOf } from "../src/adapters/types.js";

test("decisions round-trip", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sc-test-"));
  assert.equal(loadDecisions(dir), null);
  appendDecision(dir, "Pilih SQLite untuk index lokal");
  const loaded = loadDecisions(dir);
  assert.ok(loaded && loaded.includes("SQLite"));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("keputusan multi-baris diringkas jadi satu baris daftar", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sc-test-"));
  appendDecision(dir, "Pakai SQLite\nbukan Postgres");
  const loaded = loadDecisions(dir) ?? "";
  assert.ok(loaded.includes("Pakai SQLite bukan Postgres"));
  // Satu keputusan = satu baris daftar; newline mentah akan memecah markdown.
  assert.equal(
    loaded.split("\n").filter((l) => l.startsWith("- ")).length,
    1
  );
  fs.rmSync(dir, { recursive: true, force: true });
});

test("teks keputusan kosong ditolak", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sc-test-"));
  assert.throws(() => appendDecision(dir, "   \n  "));
  assert.equal(loadDecisions(dir), null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("listDecisions mengembalikan entri berurutan", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sc-test-"));
  assert.deepEqual(listDecisions(dir), []);
  appendDecision(dir, "Keputusan pertama");
  appendDecision(dir, "Keputusan kedua");
  const entries = listDecisions(dir);
  assert.equal(entries.length, 2);
  assert.ok(entries[0].endsWith("Keputusan pertama"));
  assert.ok(entries[1].endsWith("Keputusan kedua"));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("lineOf counts lines", () => {
  assert.equal(lineOf("a\nb\nc", 0), 1);
  assert.equal(lineOf("a\nb\nc", 4), 3);
});
