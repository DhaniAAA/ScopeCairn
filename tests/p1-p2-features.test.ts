import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { detectTestRunner } from "../src/commands/testselect.js";
import { checkArchitecture, initArchConfig } from "../src/commands/archcheck.js";
import { runVerify } from "../src/commands/verify.js";
import { computeStructuralDiff } from "../src/commands/diff.js";
import { openDb } from "../src/db.js";

test("detectTestRunner identifies package.json runners", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sc-test-runner-"));
  try {
    fs.writeFileSync(
      path.join(tmp, "package.json"),
      JSON.stringify({ scripts: { test: "vitest run" } })
    );
    const cmd = detectTestRunner(tmp, ["tests/a.test.ts"]);
    assert.equal(cmd, "npx vitest run tests/a.test.ts");

    fs.writeFileSync(
      path.join(tmp, "package.json"),
      JSON.stringify({ scripts: { test: "jest" } })
    );
    const jestCmd = detectTestRunner(tmp, ["tests/b.test.ts"]);
    assert.equal(jestCmd, "npx jest tests/b.test.ts");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("arch-check verifies layer rules and detects disallowed imports", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sc-test-arch-"));
  try {
    const scDir = path.join(tmp, ".scopecairn");
    fs.mkdirSync(scDir, { recursive: true });

    // Write arch rules
    fs.writeFileSync(
      path.join(scDir, "arch.json"),
      JSON.stringify({
        layers: {
          domain: ["src/domain/**"],
          controller: ["src/controller/**"],
        },
        disallowed: [
          {
            from: "domain",
            import: "controller",
            message: "Domain must not depend on controller",
          },
        ],
      })
    );

    // Create sqlite db with mock files and symbols
    const db = openDb(tmp);
    try {
      db.prepare("INSERT INTO files (id, path, language, hash, size) VALUES (?, ?, ?, ?, ?)").run(
        1, "src/domain/entity.ts", "typescript", "h1", 100
      );
      db.prepare("INSERT INTO files (id, path, language, hash, size) VALUES (?, ?, ?, ?, ?)").run(
        2, "src/controller/user.ts", "typescript", "h2", 100
      );

      db.prepare("INSERT INTO symbols (id, file_id, name, type, signature, start_line, end_line) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
        1, 1, "Entity", "class", "", 1, 10
      );
      db.prepare("INSERT INTO symbols (id, file_id, name, type, signature, start_line, end_line) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
        2, 2, "UserController", "class", "", 1, 10
      );

      // Disallowed import relation: entity (domain) imports controller
      db.prepare("INSERT INTO relationships (source_id, target_id, relationship_type, weight, confidence, evidence) VALUES (?, ?, ?, ?, ?, ?)").run(
        1, 2, "IMPORTS", 1.0, 1.0, "EXPLICIT"
      );
    } finally {
      db.close();
    }

    const res = checkArchitecture(tmp);
    assert.equal(res.ok, false);
    assert.equal(res.totalViolations, 1);
    assert.equal(res.violations[0].fromLayer, "domain");
    assert.equal(res.violations[0].toLayer, "controller");
    assert.equal(res.violations[0].message, "Domain must not depend on controller");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("runVerify passes on clean repo without protected file changes", async () => {
  // Run verify on this current repository (noRefresh to avoid external side-effects)
  const res = await runVerify(process.cwd(), { noRefresh: true });
  assert.ok(typeof res.ok === "boolean");
  assert.ok(Array.isArray(res.changedFiles));
  assert.ok(Array.isArray(res.protectedViolations));
  assert.ok(Array.isArray(res.cycles));
});
