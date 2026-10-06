import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadDecisions, appendDecision } from "../src/decisions.js";
import { lineOf } from "../src/adapters/types.js";

test("decisions round-trip", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sc-test-"));
  assert.equal(loadDecisions(dir), null);
  appendDecision(dir, "Pilih SQLite untuk index lokal");
  const loaded = loadDecisions(dir);
  assert.ok(loaded && loaded.includes("SQLite"));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("lineOf counts lines", () => {
  assert.equal(lineOf("a\nb\nc", 0), 1);
  assert.equal(lineOf("a\nb\nc", 4), 3);
});
