import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { scanRepository } from "../src/scanner.js";
import { runVerify, cmdVerify, buildVerifySarif, computePrRisk } from "../src/commands/verify.js";
import { installCiWorkflow, CI_WORKFLOW_REL } from "../src/commands/init.js";
import { detectDefaultBaseRef } from "../src/retrieval/gitChanged.js";
import { openDb } from "../src/db.js";
import { loadProtectedPatterns } from "../src/scope/protected.js";
import { scanSecretsInDiff, scanUnifiedDiffForSecrets } from "../src/scope/secrets.js";

function git(repo: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd: repo,
    encoding: "utf8",
    timeout: 10000,
    stdio: ["ignore", "pipe", "ignore"],
  });
}

function createGitRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sc-devsecops-"));
  git(dir, ["init"]);
  git(dir, ["config", "user.email", "sec@example.com"]);
  git(dir, ["config", "user.name", "Sec Tester"]);
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "src", "config.ts"),
    `export function getApiUrl(): string {\n  return "https://api.example.com";\n}\n`,
    "utf8"
  );
  git(dir, ["add", "."]);
  git(dir, ["commit", "-m", "feat: initial config"]);
  return dir;
}

test("scanUnifiedDiffForSecrets mendeteksi secret pada baris tambah, menyamarkan preview, dan mengabaikan placeholder", () => {
  const fakeGhp = "ghp_" + "1234567890abcdefghij123456";
  const fakePlaceholder = "sk-" + "your_example_placeholder_key_12345";
  const diff = [
    "--- a/src/config.ts",
    "+++ b/src/config.ts",
    "@@ -2,1 +2,3 @@",
    `+export const TOKEN = "${fakeGhp}";`,
    `+export const SAMPLE = "${fakePlaceholder}";`,
  ].join("\n");

  const findings = scanUnifiedDiffForSecrets(diff, "src/config.ts");
  assert.equal(findings.length, 1);
  assert.equal(findings[0].file, "src/config.ts");
  assert.equal(findings[0].line, 2);
  assert.equal(findings[0].kind, "GitHub Token");
  assert.ok(!findings[0].preview.includes(fakeGhp), "preview tidak boleh membocorkan secret mentah");
  assert.ok(findings[0].preview.includes("***"));
});

test("runVerify & cmdVerify --sarif melaporkan secret diff dan arch violations dalam SARIF v2.1.0", async () => {
  const repo = createGitRepo();
  const origLog = console.log;
  const origExit = process.exitCode;
  const logs: string[] = [];
  try {
    await scanRepository(repo);

    // Tambah aturan arsitektur yang dilanggar
    fs.mkdirSync(path.join(repo, "src", "domain"), { recursive: true });
    fs.mkdirSync(path.join(repo, "src", "ui"), { recursive: true });
    fs.writeFileSync(path.join(repo, "src", "ui", "view.ts"), `export const v = 1;\n`, "utf8");
    fs.writeFileSync(
      path.join(repo, "src", "domain", "model.ts"),
      `import { v } from "../ui/view.js";\nexport const m = v;\n`,
      "utf8"
    );
    fs.writeFileSync(
      path.join(repo, ".scopecairn", "arch.json"),
      JSON.stringify({
        layers: { domain: ["src/domain/**"], ui: ["src/ui/**"] },
        disallowed: [{ from: "domain", import: "ui", message: "Domain cannot import UI" }],
      }),
      "utf8"
    );

    // Bocorkan secret di src/config.ts
    const fakeAws = "AKIA" + "1234567890ABCDEF";
    fs.writeFileSync(
      path.join(repo, "src", "config.ts"),
      `export function getApiUrl(): string {\n  const aws = "${fakeAws}";\n  return aws;\n}\n`,
      "utf8"
    );

    await scanRepository(repo);

    const secrets = scanSecretsInDiff(repo, ["src/config.ts"]);
    assert.equal(secrets.length, 1);
    assert.equal(secrets[0].kind, "AWS Access Key");

    const verifyRes = await runVerify(repo, { arch: true, noRefresh: true });
    assert.equal(verifyRes.ok, false);
    assert.equal(verifyRes.secretFindings.length, 1);
    assert.equal(verifyRes.arch?.totalViolations, 1);

    const sarif = buildVerifySarif(verifyRes);
    assert.equal(sarif.version, "2.1.0");
    const ruleIds = new Set(sarif.runs[0].results.map((r) => r.ruleId));
    assert.ok(ruleIds.has("secret-detected"));
    assert.ok(ruleIds.has("arch-violation"));
    const registered = new Set(sarif.runs[0].tool.driver.rules.map((r) => r.id));
    for (const id of ruleIds) {
      assert.ok(registered.has(id), `ruleId ${id} harus terdaftar di driver.rules`);
    }

    console.log = (...args: unknown[]) => logs.push(args.map(String).join(" "));
    process.exitCode = 0;
    await cmdVerify(repo, { arch: true, sarif: true, noRefresh: true });
    assert.equal(process.exitCode, 1);
    const parsed = JSON.parse(logs.join("\n"));
    assert.equal(parsed.version, "2.1.0");
    assert.ok(parsed.runs[0].results.some((r: { ruleId: string }) => r.ruleId === "secret-detected"));
    assert.ok(parsed.runs[0].results.some((r: { ruleId: string }) => r.ruleId === "arch-violation"));
  } finally {
    console.log = origLog;
    process.exitCode = origExit;
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("installCiWorkflow menulis GitHub Actions workflow dengan Node 22 dan upload SARIF", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "sc-ci-tpl-"));
  try {
    const msg = installCiWorkflow(repo, "scopecairn");
    assert.ok(msg.includes(CI_WORKFLOW_REL));
    const yml = fs.readFileSync(path.join(repo, CI_WORKFLOW_REL), "utf8");
    assert.ok(yml.includes("node-version: 22"));
    assert.ok(yml.includes("security-events: write"));
    assert.ok(yml.includes("--sarif"));
    assert.ok(yml.includes("github/codeql-action/upload-sarif@v3"));
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("detectDefaultBaseRef & installCiWorkflow mendeteksi branch master otomatis", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "sc-master-branch-"));
  try {
    git(repo, ["init", "-b", "master"]);
    git(repo, ["config", "user.email", "sec@example.com"]);
    git(repo, ["config", "user.name", "Sec Tester"]);
    fs.writeFileSync(path.join(repo, "README.md"), "hello\n", "utf8");
    git(repo, ["add", "."]);
    git(repo, ["commit", "-m", "init"]);

    assert.equal(detectDefaultBaseRef(repo), "master");
    assert.equal(detectDefaultBaseRef(repo, { preferOrigin: true }), "origin/master");

    installCiWorkflow(repo, "scopecairn");
    const yml = fs.readFileSync(path.join(repo, CI_WORKFLOW_REL), "utf8");
    assert.ok(yml.includes("--base origin/master"), "workflow CI harus memakai origin/master");
    assert.ok(!yml.includes("--base origin/main"));
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("computePrRisk menandai file di dalam dependency cycle sebagai HIGH lewat batch lookup", async () => {
  const repo = createGitRepo();
  try {
    fs.writeFileSync(
      path.join(repo, "src", "a.ts"),
      `import { b } from "./b.js";\nexport function a(): number { return b(); }\n`,
      "utf8"
    );
    fs.writeFileSync(
      path.join(repo, "src", "b.ts"),
      `import { a } from "./a.js";\nexport function b(): number { return a(); }\n`,
      "utf8"
    );
    await scanRepository(repo);

    const db = openDb(repo);
    try {
      const report = computePrRisk(db, repo, ["src/a.ts", "src/config.ts"], "HEAD", loadProtectedPatterns(repo));
      const fileA = report.files.find((f) => f.path === "src/a.ts");
      const fileCfg = report.files.find((f) => f.path === "src/config.ts");
      assert.equal(fileA?.inCycle, true);
      assert.equal(fileA?.risk, "HIGH");
      assert.equal(fileCfg?.inCycle, false);
      assert.equal(report.aggregate, "HIGH");
    } finally {
      db.close();
    }
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("secrets scanner mendukung inline suppression (scopecairn:ignore-secret) serta allowlist & custom rules di config.yml", () => {
  const repo = createGitRepo();
  try {
    const fakeGhp = "ghp_" + "9876543210abcdefghij987654";
    const diffSuppressed = [
      "--- a/src/config.ts",
      "+++ b/src/config.ts",
      "@@ -2,1 +2,3 @@",
      `+export const MOCK_GHP = "${fakeGhp}"; // scopecairn:ignore-secret`,
      `+export const LIVE_GHP = "${fakeGhp}";`,
    ].join("\n");
    const supFindings = scanUnifiedDiffForSecrets(diffSuppressed, "src/config.ts");
    assert.equal(supFindings.length, 1);
    assert.equal(supFindings[0].line, 3);

    // Konfigurasi .scopecairn/config.yml: allowlist + custom rules
    fs.mkdirSync(path.join(repo, ".scopecairn"), { recursive: true });
    fs.writeFileSync(
      path.join(repo, ".scopecairn", "config.yml"),
      [
        "w_seed: 0.5",
        "secrets_allowlist:",
        `  - ${fakeGhp}`,
        "secrets_rules:",
        "  - Internal Token::\\bint_live_[A-Za-z0-9]{16,}\\b",
      ].join("\n"),
      "utf8"
    );

    const internalSecret = "int_live_" + "AbCdEfGh1234567890";
    fs.writeFileSync(
      path.join(repo, "src", "config.ts"),
      [
        `export const ALLOWED = "${fakeGhp}";`,
        `export const INTERNAL = "${internalSecret}";`,
      ].join("\n"),
      "utf8"
    );

    const diffFindings = scanSecretsInDiff(repo, ["src/config.ts"]);
    assert.equal(diffFindings.length, 1);
    assert.equal(diffFindings[0].kind, "Internal Token");
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});
