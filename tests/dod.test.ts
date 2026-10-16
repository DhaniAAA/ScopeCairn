// Test penilai Definition of Done: hanya item yang benar-benar bisa
// diverifikasi mesin yang diberi status pass/warn/fail — sisanya `manual`,
// tidak pernah diklaim lulus.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  evaluateDod,
  dodFailed,
  renderDod,
  collectAffectedTests,
  type DodInput,
} from "../src/scope/dod.js";
import { DEFINITION_OF_DONE } from "../src/scope/guard.js";

const BASE: DodInput = {
  changedFiles: [],
  scopeChecked: false,
  scopeViolations: [],
  affectedTests: [],
  indexRefreshed: true,
};

const statusOf = (checks: ReturnType<typeof evaluateDod>, item: string) =>
  checks.find((c) => c.item === item)?.status;

test("satu entri per item Definition of Done, urutan sama", () => {
  const checks = evaluateDod(BASE);
  assert.deepEqual(
    checks.map((c) => c.item),
    [...DEFINITION_OF_DONE]
  );
});

test("tanpa perubahan file: tidak ada pemeriksaan yang gagal", () => {
  const checks = evaluateDod(BASE);
  assert.equal(dodFailed(checks), false);
  assert.equal(statusOf(checks, "Test relevan lulus"), "manual");
  assert.equal(statusOf(checks, "Index dimutakhirkan (`scopecairn scan`)"), "pass");
});

test("scope violation membuat item scope gagal", () => {
  const checks = evaluateDod({
    ...BASE,
    changedFiles: ["src/a.ts", "src/lain.ts"],
    scopeChecked: true,
    scopeViolations: ["src/lain.ts"],
  });
  const item = checks.find((c) => c.item === "Tidak ada file berubah tanpa alasan");
  assert.equal(item?.status, "fail");
  assert.ok(item?.detail.includes("src/lain.ts"));
  assert.equal(dodFailed(checks), true);
});

test("tanpa --task, pemeriksaan scope ditandai manual", () => {
  const checks = evaluateDod({ ...BASE, changedFiles: ["src/a.ts"] });
  assert.equal(statusOf(checks, "Tidak ada file berubah tanpa alasan"), "manual");
  assert.equal(dodFailed(checks), false);
});

test("perubahan tanpa test terkait memberi peringatan", () => {
  const checks = evaluateDod({ ...BASE, changedFiles: ["src/a.ts"] });
  assert.equal(statusOf(checks, "Test relevan lulus"), "warn");
  assert.equal(dodFailed(checks), false); // warn bukan gagal
  const withTests = evaluateDod({
    ...BASE,
    changedFiles: ["src/a.ts"],
    affectedTests: ["tests/a.test.ts"],
  });
  const item = withTests.find((c) => c.item === "Test relevan lulus");
  assert.equal(item?.status, "manual");
  assert.ok(item?.detail.includes("tests/a.test.ts"));
});

test("index yang tidak di-refresh hanya memperingatkan", () => {
  const checks = evaluateDod({ ...BASE, indexRefreshed: false });
  assert.equal(statusOf(checks, "Index dimutakhirkan (`scopecairn scan`)"), "warn");
  assert.equal(dodFailed(checks), false);
});

test("item tak dikenal otomatis manual, bukan diklaim lulus", () => {
  const checks = evaluateDod(BASE, ["Item baru dari guard yang belum ada penilainya"]);
  assert.deepEqual(checks, [
    {
      item: "Item baru dari guard yang belum ada penilainya",
      status: "manual",
      detail: "tidak dapat diverifikasi otomatis",
    },
  ]);
});

test("collectAffectedTests mengikuti arah edge TESTS (test -> file yang diuji)", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE files (id INTEGER PRIMARY KEY, path TEXT);
    CREATE TABLE symbols (id INTEGER PRIMARY KEY, file_id INTEGER, type TEXT);
    CREATE TABLE relationships (source_id INTEGER, target_id INTEGER, relationship_type TEXT);
  `);
  db.exec(`
    INSERT INTO files (id, path) VALUES
      (1, 'src/cycles.ts'), (2, 'tests/cycles.test.ts'), (3, 'src/lain.ts');
    INSERT INTO symbols (id, file_id, type) VALUES (1, 1, 'file'), (2, 2, 'file'), (3, 3, 'file');
    INSERT INTO relationships (source_id, target_id, relationship_type)
      VALUES (2, 1, 'TESTS');
  `);
  try {
    // File sumber berubah → file test yang mengujinya ikut terdeteksi.
    assert.deepEqual(collectAffectedTests(db, ["src/cycles.ts"]), ["tests/cycles.test.ts"]);
    // File test itu sendiri yang berubah → tetap dihitung sebagai test relevan.
    assert.deepEqual(collectAffectedTests(db, ["tests/cycles.test.ts"]), ["tests/cycles.test.ts"]);
    // File tak berhubungan → tidak ada test.
    assert.deepEqual(collectAffectedTests(db, ["src/lain.ts"]), []);
    assert.deepEqual(collectAffectedTests(db, []), []);
  } finally {
    db.close();
  }
});

test("renderDod memakai penanda status dan menutup dengan ringkasan", () => {
  const checks = evaluateDod({
    ...BASE,
    changedFiles: ["src/a.ts"],
    scopeChecked: true,
    scopeViolations: [],
    affectedTests: ["tests/a.test.ts"],
  });
  const out = renderDod(checks);
  assert.ok(out.includes("## Definition of Done"));
  assert.ok(out.includes("[✓]"));
  assert.ok(out.includes("[ ]"));
  // Scope & index lolos; sisanya penilaian manual yang jujur.
  assert.ok(out.includes("2 pass"));
  assert.ok(out.includes("4 manual"));
});
