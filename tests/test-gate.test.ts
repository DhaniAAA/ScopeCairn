import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { installPreCommitHook } from "../src/commands/init.js";
import { runVerify, cmdVerify } from "../src/commands/verify.js";
import { scanRepository } from "../src/scanner.js";
import {
  BYPASS_LIMITATION_NOTE,
  detectGateRunner,
  detectWeakenedTests,
  detectWeakenedTestsFromDiff,
  evaluateChangedLinesCoverage,
  evaluateMutationGate,
  parseChangedLineNumbersFromUnifiedDiff,
  runTestGate,
} from "../src/scope/testGate.js";

function git(repo: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd: repo,
    encoding: "utf8",
    timeout: 10000,
    stdio: ["ignore", "pipe", "ignore"],
  });
}

function createRunnerRepo(runner: "vitest" | "jest" | "node"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `sc-gate-${runner}-`));
  git(dir, ["init"]);
  git(dir, ["config", "user.email", "gate@example.com"]);
  git(dir, ["config", "user.name", "Gate Tester"]);

  const scripts: Record<string, string> =
    runner === "vitest"
      ? { test: "vitest run" }
      : runner === "jest"
        ? { test: "jest" }
        : { test: "node --test" };

  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({ name: "fixture-gate", version: "1.0.0", scripts }, null, 2),
    "utf8"
  );
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.mkdirSync(path.join(dir, "tests"), { recursive: true });

  fs.writeFileSync(
    path.join(dir, "src", "math.ts"),
    [
      "export function add(a: number, b: number): number {",
      "  return a + b;",
      "}",
      "",
    ].join("\n"),
    "utf8"
  );

  fs.writeFileSync(
    path.join(dir, "tests", "math.test.ts"),
    [
      'import { add } from "../src/math.js";',
      'test("add menjumlahkan dua angka", () => {',
      "  expect(add(2, 3)).toBe(5);",
      "  expect(add(-1, 1)).toBe(0);",
      "});",
      "",
    ].join("\n"),
    "utf8"
  );

  git(dir, ["add", "."]);
  git(dir, ["commit", "-m", "feat: initial math module and tests"]);
  return dir;
}

test("installPreCommitHook memasang verify --test-gate dan mendokumentasikan keterbatasan --no-verify", () => {
  const repo = createRunnerRepo("vitest");
  try {
    const status = installPreCommitHook(repo, "scopecairn");
    assert.ok(status.includes("installed"));
    const hookContent = fs.readFileSync(path.join(repo, ".git", "hooks", "pre-commit"), "utf8");
    assert.ok(
      hookContent.includes("scopecairn verify --no-strict --test-gate"),
      "hook harus menjalankan verify --no-strict --test-gate"
    );
    assert.ok(
      hookContent.includes("--no-verify") && hookContent.includes("CI"),
      "hook harus mendokumentasikan keterbatasan --no-verify dan rekomendasi CI"
    );
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("detectGateRunner mengenali Vitest dan Jest serta menandai runner lain sebagai unsupported", () => {
  const vitestRepo = createRunnerRepo("vitest");
  const jestRepo = createRunnerRepo("jest");
  const nodeRepo = createRunnerRepo("node");
  try {
    assert.equal(detectGateRunner(vitestRepo), "vitest");
    assert.equal(detectGateRunner(jestRepo), "jest");
    assert.equal(detectGateRunner(nodeRepo), "unsupported");
  } finally {
    fs.rmSync(vitestRepo, { recursive: true, force: true });
    fs.rmSync(jestRepo, { recursive: true, force: true });
    fs.rmSync(nodeRepo, { recursive: true, force: true });
  }
});

test("detectWeakenedTestsFromDiff & detectWeakenedTests menangkap assertion dihapus, skip ditambahkan, dan matcher dilonggarkan", () => {
  // 1. Unit test langsung pada variasi diff
  const diffRemovedAssertion = [
    "--- a/tests/math.test.ts",
    "+++ b/tests/math.test.ts",
    "@@ -2,4 +2,3 @@",
    " test('add', () => {",
    "-  expect(add(2, 3)).toBe(5);",
    "-  expect(add(-1, 1)).toBe(0);",
    "+  expect(add(2, 3)).toBe(5);",
    " });",
  ].join("\n");
  const r1 = detectWeakenedTestsFromDiff(diffRemovedAssertion, "tests/math.test.ts");
  assert.ok(r1.some((f) => f.kind === "assertion_removed"));

  const diffSkipAdded = [
    "--- a/tests/math.test.ts",
    "+++ b/tests/math.test.ts",
    "@@ -2,2 +2,2 @@",
    "-test('add', () => {",
    "+test.skip('add', () => {",
  ].join("\n");
  const r2 = detectWeakenedTestsFromDiff(diffSkipAdded, "tests/math.test.ts");
  assert.ok(r2.some((f) => f.kind === "skip_added"));

  const diffMatcherLoosened = [
    "--- a/tests/math.test.ts",
    "+++ b/tests/math.test.ts",
    "@@ -2,2 +2,2 @@",
    "-  expect(add(2, 3)).toBe(5);",
    "+  expect(add(2, 3)).toBeDefined();",
  ].join("\n");
  const r3 = detectWeakenedTestsFromDiff(diffMatcherLoosened, "tests/math.test.ts");
  assert.ok(r3.some((f) => f.kind === "matcher_loosened"));

  const diffTautological = [
    "--- a/tests/math.test.ts",
    "+++ b/tests/math.test.ts",
    "@@ -2,2 +2,3 @@",
    "   expect(add(2, 3)).toBe(5);",
    "+  expect(true).toBe(true);",
  ].join("\n");
  const r4 = detectWeakenedTestsFromDiff(diffTautological, "tests/math.test.ts");
  assert.ok(r4.some((f) => f.kind === "matcher_loosened"));

  // 2. Integrasi pada repo git nyata
  const repo = createRunnerRepo("vitest");
  try {
    // Lemahkan test di working tree: tambah skip + hapus 1 assertion + longgarkan matcher
    fs.writeFileSync(
      path.join(repo, "tests", "math.test.ts"),
      [
        'import { add } from "../src/math.js";',
        'test.skip("add menjumlahkan dua angka", () => {',
        "  expect(add(2, 3)).toBeTruthy();",
        "});",
        "",
      ].join("\n"),
      "utf8"
    );

    const findings = detectWeakenedTests(repo, ["tests/math.test.ts"]);
    const kinds = new Set(findings.map((f) => f.kind));
    assert.ok(kinds.has("assertion_removed"), "harus mendeteksi assertion_removed");
    assert.ok(kinds.has("skip_added"), "harus mendeteksi skip_added");
    assert.ok(kinds.has("matcher_loosened"), "harus mendeteksi matcher_loosened");
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("evaluateChangedLinesCoverage menghitung coverage baris yang diubah dari Istanbul JSON dan LCOV serta menghormati ambang config.yml", () => {
  // Uji parser nomor baris unified diff
  const sampleHunk = "@@ -3,0 +4,3 @@\n+  const x = a * b;\n+  const y = x + 1;\n+  return y;\n";
  assert.deepEqual(parseChangedLineNumbersFromUnifiedDiff(sampleHunk), [4, 5, 6]);

  const repo = createRunnerRepo("vitest");
  try {
    // Tambahkan fungsi baru multiply (baris 5..9) di src/math.ts
    fs.writeFileSync(
      path.join(repo, "src", "math.ts"),
      [
        "export function add(a: number, b: number): number {",
        "  return a + b;",
        "}",
        "export function multiply(a: number, b: number): number {",
        "  const prod = a * b;",
        "  if (prod === 0) {",
        "    return 0;",
        "  }",
        "  return prod;",
        "}",
        "",
      ].join("\n"),
      "utf8"
    );

    // Tulis coverage/coverage-final.json dengan hanya 2 dari 4 baris baru yang ter-cover (50% < 80%)
    fs.mkdirSync(path.join(repo, "coverage"), { recursive: true });
    const absMath = path.join(repo, "src", "math.ts");
    fs.writeFileSync(
      path.join(repo, "coverage", "coverage-final.json"),
      JSON.stringify({
        [absMath]: {
          path: absMath,
          l: { "2": 1, "4": 1, "5": 1, "6": 0, "7": 0, "9": 0 },
        },
      }),
      "utf8"
    );

    const lowCov = evaluateChangedLinesCoverage(repo, ["src/math.ts"], { threshold: 80 });
    assert.equal(lowCov.status, "fail");
    assert.equal(lowCov.runner, "vitest");
    assert.ok(lowCov.pct < 80, `coverage harus < 80%, dapat ${lowCov.pct}%`);
    assert.ok(lowCov.files[0].uncoveredLines.includes(6));
    assert.ok(lowCov.files[0].uncoveredLines.includes(7));

    // Sekarang uji format LCOV dengan seluruh baris berubah ter-cover (100% >= 80%)
    fs.rmSync(path.join(repo, "coverage", "coverage-final.json"));
    fs.writeFileSync(
      path.join(repo, "coverage", "lcov.info"),
      [
        "TN:",
        `SF:src/math.ts`,
        "DA:2,1",
        "DA:4,2",
        "DA:5,2",
        "DA:6,2",
        "DA:7,1",
        "DA:9,1",
        "end_of_record",
        "",
      ].join("\n"),
      "utf8"
    );

    const highCov = evaluateChangedLinesCoverage(repo, ["src/math.ts"], { threshold: 80 });
    assert.equal(highCov.status, "pass");
    assert.equal(highCov.pct, 100);
    assert.deepEqual(highCov.files[0].uncoveredLines, []);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("evaluateMutationGate bersifat opsional secara default dan memeriksa laporan Stryker saat diaktifkan", () => {
  const repo = createRunnerRepo("jest");
  try {
    fs.writeFileSync(
      path.join(repo, "src", "math.ts"),
      "export function add(a: number, b: number): number {\n  return a + b;\n}\nexport function sub(a: number, b: number): number {\n  return a - b;\n}\n",
      "utf8"
    );

    // Default: nonaktif (skipped) tetapi memberikan command Stryker untuk Jest
    const disabled = evaluateMutationGate(repo, ["src/math.ts"], {
      enabled: false,
      threshold: 60,
    });
    assert.equal(disabled.enabled, false);
    assert.equal(disabled.status, "skipped");
    assert.equal(disabled.command, "npx stryker run --mutate src/math.ts --testRunner jest");

    // Aktifkan dengan laporan Stryker di reports/mutation/mutation.json (1 Killed, 3 Survived = 25% < 60%)
    fs.mkdirSync(path.join(repo, "reports", "mutation"), { recursive: true });
    fs.writeFileSync(
      path.join(repo, "reports", "mutation", "mutation.json"),
      JSON.stringify({
        files: {
          "src/math.ts": {
            mutants: [
              { status: "Killed" },
              { status: "Survived" },
              { status: "Survived" },
              { status: "NoCoverage" },
            ],
          },
        },
      }),
      "utf8"
    );

    const failedMut = evaluateMutationGate(repo, ["src/math.ts"], {
      enabled: true,
      threshold: 60,
    });
    assert.equal(failedMut.status, "fail");
    assert.equal(failedMut.score, 25);

    // Perbaiki laporan Stryker menjadi 3 Killed, 1 Survived (75% >= 60%)
    fs.writeFileSync(
      path.join(repo, "reports", "mutation", "mutation.json"),
      JSON.stringify({
        files: {
          "src/math.ts": {
            mutants: [
              { status: "Killed" },
              { status: "Killed" },
              { status: "Timeout" },
              { status: "Survived" },
            ],
          },
        },
      }),
      "utf8"
    );

    const passedMut = evaluateMutationGate(repo, ["src/math.ts"], {
      enabled: true,
      threshold: 60,
    });
    assert.equal(passedMut.status, "pass");
    assert.equal(passedMut.score, 75);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("runVerify & cmdVerify dengan --test-gate menggagalkan verifikasi saat test dilemahkan dan menyertakan catatan --no-verify", async () => {
  const repo = createRunnerRepo("vitest");
  const origLog = console.log;
  const origExit = process.exitCode;
  const logs: string[] = [];
  try {
    await scanRepository(repo);

    // Konfigurasi coverage_threshold: 85 di .scopecairn/config.yml
    fs.writeFileSync(
      path.join(repo, ".scopecairn", "config.yml"),
      "coverage_threshold: 85\nmutation_enabled: false\n",
      "utf8"
    );

    // Lemahkan test dengan menambahkan .skip
    fs.writeFileSync(
      path.join(repo, "tests", "math.test.ts"),
      'import { add } from "../src/math.js";\ntest.skip("add", () => {\n  expect(add(2, 3)).toBe(5);\n});\n',
      "utf8"
    );

    const gateRes = runTestGate(repo, ["tests/math.test.ts"]);
    assert.equal(gateRes.ok, false);
    assert.equal(gateRes.coverage.threshold, 85, "harus membaca coverage_threshold dari config.yml");
    assert.equal(gateRes.limitationNote, BYPASS_LIMITATION_NOTE);

    const verifyRes = await runVerify(repo, {
      testGate: true,
      strict: false,
      noRefresh: true,
    });
    assert.equal(verifyRes.ok, false, "verify harus gagal bila testGate tidak lolos");
    assert.ok(verifyRes.testGate);
    assert.ok(verifyRes.testGate.weakenedTests.length > 0);

    console.log = (...args: unknown[]) => logs.push(args.map(String).join(" "));
    process.exitCode = 0;
    await cmdVerify(repo, { testGate: true, strict: false, noRefresh: true });
    assert.equal(process.exitCode, 1);
    const fullOut = logs.join("\n");
    assert.ok(fullOut.includes("## Testing Gate"));
    assert.ok(fullOut.includes("--no-verify"));
  } finally {
    console.log = origLog;
    process.exitCode = origExit;
    fs.rmSync(repo, { recursive: true, force: true });
  }
});
