// Regresi enforcement scope + skala retrieval.
//
// Menutup celah yang sebelumnya tak ada testnya:
//   - `verify --task` tak pernah diuji benar-benar menandai file out-of-scope.
//   - Scope dihitung ulang di `verify` (jalur terpisah) → bisa berbeda dari
//     yang dilihat agent (co-change riwayat, --escalate, task SIMPLE).
//   - `git status --porcelain` hanya melihat working tree vs HEAD → perubahan
//     yang sudah di-commit lolos diam-diam.
//   - `retrieve()` memindai seluruh tabel relationships tiap panggilan.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { openDb } from "../src/db.js";
import { scanRepository } from "../src/scanner.js";
import { runVerify } from "../src/commands/verify.js";
import { cmdContext } from "../src/commands/context.js";
import { changedFilesVsBase, changedFilesVsHead } from "../src/retrieval/gitChanged.js";
import { gitSignals, gitSignalsFromDb } from "../src/retrieval/git.js";
import { persistScope, loadPersistedScope } from "../src/scope/taskScope.js";
import {
  claudeSkillMd,
  cursorRuleMdc,
  genericRuleMd,
  opencodeCommandMd,
  skillMd,
  workflowMd,
} from "../src/integrate/templates.js";

function git(repo: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd: repo,
    encoding: "utf8",
    timeout: 15000,
    stdio: ["ignore", "pipe", "ignore"],
  });
}

function initGitRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sc-scope-"));
  git(dir, ["init"]);
  git(dir, ["config", "user.email", "t@example.com"]);
  git(dir, ["config", "user.name", "Test"]);
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  return dir;
}

/** Source repo minimal: satu file relevan + satu file takhubungan. */
function writeRepoFiles(repo: string): void {
  fs.writeFileSync(
    path.join(repo, "src", "refund.ts"),
    `export function refundCharge(orderId: string): number {\n  return orderId.length;\n}\n` +
      `export function refundTotal(amount: number): number {\n  return amount;\n}\n`
  );
  fs.writeFileSync(
    path.join(repo, "src", "unrelated.ts"),
    `export function unrelatedHelper(): string {\n  return "unrelated";\n}\n`
  );
  git(repo, ["add", "."]);
  git(repo, ["commit", "-m", "feat: initial"]);
}

/** Jalankan context tanpa polusi stdout test. */
async function runContext(repo: string, task: string): Promise<void> {
  const log = console.log;
  const err = console.error;
  console.log = () => {};
  console.error = () => {};
  try {
    await cmdContext(repo, task, { noRefresh: true });
  } finally {
    console.log = log;
    console.error = err;
  }
}

test("context menyimpan scope; verify --task menandai file yang diubah di luar scope", async () => {
  const repo = initGitRepo();
  try {
    writeRepoFiles(repo);
    await scanRepository(repo);

    const task = "refund charge handler";
    await runContext(repo, task);

    // Scope harus tersimpan — ini kontak yang sama dengan agent.
    const db = openDb(repo);
    let persisted;
    try {
      persisted = loadPersistedScope(db, task);
    } finally {
      db.close();
    }
    assert.ok(persisted, "scope harus tersimpan setelah context");
    assert.ok(
      persisted!.scope.required.includes("src/refund.ts"),
      `src/refund.ts harus masuk Required, got ${JSON.stringify(persisted!.scope)}`
    );

    // Agent menyentuh file yang tak ada di scope.
    fs.writeFileSync(
      path.join(repo, "src", "unrelated.ts"),
      `export function unrelatedHelper(): string {\n  return "changed";\n}\n`
    );

    const res = await runVerify(repo, { task, noRefresh: true });
    assert.equal(res.scopeSource, "persisted", "verify harus memakai scope tersimpan");
    assert.ok(
      res.scopeViolations.includes("src/unrelated.ts"),
      `src/unrelated.ts harus jadi scope violation, got ${JSON.stringify(res.scopeViolations)}`
    );
    // File in-scope tak boleh dianggap pelanggaran.
    assert.ok(!res.scopeViolations.includes("src/refund.ts"));
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("verify --task menandai file out-of-scope meski context tak pernah dijalankan", async () => {
  const repo = initGitRepo();
  try {
    writeRepoFiles(repo);
    await scanRepository(repo);

    fs.writeFileSync(
      path.join(repo, "src", "unrelated.ts"),
      `export function unrelatedHelper(): string {\n  return "changed";\n}\n`
    );

    const res = await runVerify(repo, { task: "refund charge handler", noRefresh: true });
    assert.equal(res.scopeSource, "computed");
    assert.ok(
      res.scopeViolations.includes("src/unrelated.ts"),
      `scope fallback harus tetap menandai file asing, got ${JSON.stringify(res.scopeViolations)}`
    );
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("scope kosong → cek dilewati (scopeUndetermined), bukan semua file jadi pelanggaran", async () => {
  const repo = initGitRepo();
  try {
    fs.writeFileSync(path.join(repo, "README.md"), "# hello\n");
    fs.writeFileSync(
      path.join(repo, "src", "a.ts"),
      `export function alphaBetaGamma(): number {\n  return 1;\n}\n`
    );
    git(repo, ["add", "."]);
    git(repo, ["commit", "-m", "feat: init"]);
    await scanRepository(repo);

    // Task yang tak cocok dengan simbol mana pun → scope tak terisi.
    fs.writeFileSync(
      path.join(repo, "src", "a.ts"),
      `export function alphaBetaGamma(): number {\n  return 2;\n}\n`
    );
    const res = await runVerify(repo, {
      task: "zzzqqqxyzzy tidak ada di index sama sekali",
      noRefresh: true,
    });
    assert.equal(res.scopeUndetermined, true, "scope kosong harus ditandai undetermined");
    assert.equal(
      res.scopeViolations.length,
      0,
      "scope kosong tak boleh menandai semua file sebagai pelanggaran"
    );
    // DoD tak boleh mengklaim "pass" untuk cek yang tak dijalankan.
    const dod = await runVerify(repo, {
      task: "zzzqqqxyzzy tidak ada di index sama sekali",
      noRefresh: true,
      dod: true,
    });
    const scopeItem = dod.dod?.find((c) => c.item === "Tidak ada file berubah tanpa alasan");
    assert.equal(scopeItem?.status, "manual", "DoD tak boleh mengklaim pass saat scope tak ditentukan");
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("--base melihat perubahan yang sudah di-commit (working tree bersih tak boleh lolos)", async () => {
  const repo = initGitRepo();
  try {
    writeRepoFiles(repo);
    await scanRepository(repo);

    fs.writeFileSync(
      path.join(repo, "src", "unrelated.ts"),
      `export function unrelatedHelper(): string {\n  return "committed";\n}\n`
    );
    git(repo, ["add", "."]);
    git(repo, ["commit", "-m", "chore: touch unrelated"]);

    // Working tree bersih → default hanya melihat 0 file (lubang lama).
    assert.deepEqual(changedFilesVsHead(repo), [], "working tree memang bersih");

    const viaBase = changedFilesVsBase(repo, "HEAD~1");
    assert.equal(viaBase.baseInvalid, false);
    assert.ok(
      viaBase.files.includes("src/unrelated.ts"),
      `--base harus melihat perubahan yang di-commit, got ${JSON.stringify(viaBase.files)}`
    );

    // verify --base ikut melihatnya.
    const res = await runVerify(repo, { task: "refund charge handler", base: "HEAD~1", noRefresh: true });
    assert.ok(
      res.scopeViolations.includes("src/unrelated.ts"),
      "verify --base harus menandai perubahan yang di-commit di luar scope"
    );
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("--base dengan ref tidak valid → gagal, bukan lolos diam-diam", async () => {
  const repo = initGitRepo();
  try {
    writeRepoFiles(repo);
    await scanRepository(repo);
    const res = await runVerify(repo, { base: "ref-yang-tidak-ada", noRefresh: true });
    assert.equal(res.baseInvalid, true, "base ref tak valid harus ditandai");
    assert.equal(res.ok, false, "base ref tak valid harus menggagalkan verify");
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("cache fanin sama dengan GROUP BY langsung atas tabel relationships", async () => {
  const repo = initGitRepo();
  try {
    writeRepoFiles(repo);
    await scanRepository(repo);

    const db = openDb(repo);
    try {
      const cached = db
        .prepare(`SELECT node_id AS id, n FROM fanin`)
        .all() as { id: number; n: number }[];
      const live = db
        .prepare(`SELECT target_id AS id, COUNT(*) AS n FROM relationships GROUP BY target_id`)
        .all() as { id: number; n: number }[];
      assert.ok(live.length > 0, "repo harus punya relasi untuk diuji");
      assert.equal(cached.length, live.length, "cache fanin harus lengkap");
      const liveMap = new Map(live.map((r) => [r.id, r.n]));
      for (const r of cached) {
        assert.equal(r.n, liveMap.get(r.id), `fan-in node ${r.id} tak cocok`);
      }
    } finally {
      db.close();
    }
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("sinyal git dari DB cocok dengan sinyal dari `git log`", async () => {
  const repo = initGitRepo();
  try {
    writeRepoFiles(repo);
    fs.writeFileSync(path.join(repo, "src", "extra.ts"), `export const x = 1;\n`);
    git(repo, ["add", "."]);
    git(repo, ["commit", "-m", "feat: add extra"]);
    await scanRepository(repo);

    const fromGit = gitSignals(repo, ["src/refund.ts"]);
    const db = openDb(repo);
    let fromDb;
    try {
      fromDb = gitSignalsFromDb(db, ["src/refund.ts"]);
    } finally {
      db.close();
    }
    assert.equal(fromGit.available, true);
    assert.equal(fromDb.available, true, "DB harus punya riwayat setelah scan");
    assert.ok(fromDb.recency.has("src/refund.ts"), "recency dari DB harus memuat file seed");
    // Co-change: file yang berubah bersama seed harus partner di kedua sumber.
    assert.equal(
      fromDb.cochange.get("src/unrelated.ts"),
      fromGit.cochange.get("src/unrelated.ts"),
      "co-change dari DB harus sama dengan dari git log"
    );
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("persistScope/loadPersistedScope: roundtrip + take-latest (escalate)", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "sc-ts-"));
  try {
    const db = openDb(repo);
    try {
      const t1 = db
        .prepare(`INSERT INTO tasks(description, complexity) VALUES (?, ?)`)
        .run("add coupon", "SIMPLE");
      persistScope(db, Number(t1.lastInsertRowid), {
        required: ["src/a.ts"],
        optional: ["src/b.ts"],
        protected: ["migrations/x.sql"],
      });
      const t2 = db
        .prepare(`INSERT INTO tasks(description, complexity) VALUES (?, ?)`)
        .run("add coupon", "COMPLEX");
      persistScope(db, Number(t2.lastInsertRowid), {
        required: ["src/a.ts", "src/c.ts"],
        optional: [],
        protected: [],
      });

      const got = loadPersistedScope(db, "add coupon");
      assert.ok(got, "scope harus ditemukan");
      assert.deepEqual(
        got!.scope.required,
        ["src/a.ts", "src/c.ts"],
        "scope terbaru (escalate) harus menang"
      );
      assert.deepEqual(got!.scope.protected, []);
      assert.equal(loadPersistedScope(db, "task tak pernah dijalankan"), null);
    } finally {
      db.close();
    }
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("semua template skill agent memerintahkan verify --task", () => {
  const templates: [string, string][] = [
    ["genericRuleMd", genericRuleMd("scopecairn")],
    ["cursorRuleMdc", cursorRuleMdc("scopecairn")],
    ["claudeSkillMd", claudeSkillMd("scopecairn")],
    ["skillMd", skillMd("scopecairn")],
    ["workflowMd", workflowMd("scopecairn")],
    ["opencodeCommandMd", opencodeCommandMd("scopecairn")],
  ];
  for (const [name, body] of templates) {
    assert.ok(
      body.includes("verify --task"),
      `${name} harus memerintahkan agent menjalankan verify --task`
    );
  }
});
