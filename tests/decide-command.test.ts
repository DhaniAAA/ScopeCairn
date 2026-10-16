// Test command `decide`: mencatat keputusan arsitektur ke .scopecairn/decisions.md
// (dibaca `context`) dan menampilkan daftarnya tanpa argumen.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runDecide } from "../src/commands/decide.js";

function tmpRepo(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "sc-decide-"));
}

test("decide tanpa argumen menampilkan daftar kosong", () => {
  const dir = tmpRepo();
  const res = runDecide(dir);
  assert.equal(res.mode, "list");
  if (res.mode === "list") assert.deepEqual(res.entries, []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("decide mencatat entri dan mengembalikannya", () => {
  const dir = tmpRepo();
  const res = runDecide(dir, "Pakai SQLite, bukan Postgres");
  assert.equal(res.mode, "added");
  if (res.mode === "added") assert.ok(res.entry.includes("Pakai SQLite, bukan Postgres"));

  const listed = runDecide(dir);
  assert.equal(listed.mode, "list");
  if (listed.mode === "list") {
    assert.equal(listed.entries.length, 1);
    assert.ok(listed.entries[0].includes("Pakai SQLite, bukan Postgres"));
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test("decide menolak teks kosong tanpa menulis file", () => {
  const dir = tmpRepo();
  const res = runDecide(dir, "   \n ");
  assert.equal(res.mode, "error");
  const listed = runDecide(dir);
  if (listed.mode === "list") assert.deepEqual(listed.entries, []);
  fs.rmSync(dir, { recursive: true, force: true });
});
