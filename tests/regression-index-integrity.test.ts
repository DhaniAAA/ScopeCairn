// Regresi untuk bug yang dulu lolos seluruh suite.
//
// Setiap test di sini gagal pada kode SEBELUM perbaikannya. Kalau salah satu
// jadi hijau tanpa perubahan sumber, berarti ada regresi baru.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { openDb } from "../src/db.js";
import { skipRefresh } from "../src/commands/opts.js";
import { detectTestRunnerPlan } from "../src/commands/testselect.js";
import { ensureHistoryIndex } from "../src/retrieval/history/extractor.js";

function tmpRepo(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

// ---------------------------------------------------------------------------
// Bug #2 — migrasi destruktif di dalam openDb()
// ---------------------------------------------------------------------------

test("openDb tidak lagi menimpa evidence='EXTRACTED' milik indexer", () => {
  const repo = tmpRepo("sc-evidence-");
  try {
    const db = openDb(repo);
    // Indexer menulis CALLS receiver-typed dengan conf 0.95 + EXTRACTED,
    // resolusi highest-confidence yang ada.
    db.exec(`INSERT INTO files(path, language, hash, size) VALUES ('a.ts','typescript','h',1)`);
    db.exec(`INSERT INTO symbols(file_id, name, type) VALUES (1,'foo','function')`);
    db.exec(
      `INSERT INTO relationships(source_id, target_id, relationship_type, confidence, evidence)
       VALUES (1, 1, 'CALLS', 0.95, 'EXTRACTED')`
    );
    db.close();

    // Buka LAGI. Sebelumnya setiap openDb() menjalankan
    //   UPDATE ... SET evidence='AMBIGUOUS' WHERE type='CALLS' AND confidence<1
    // sehingga baris di atas ikut terbalik di perintah berikutnya.
    for (let i = 0; i < 3; i++) {
      const again = openDb(repo);
      const row = again
        .prepare(`SELECT evidence FROM relationships WHERE relationship_type='CALLS'`)
        .get() as { evidence: string };
      assert.equal(row.evidence, "EXTRACTED", `evidence berubah pada open ke-${i + 2}`);
      again.close();
    }
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("backfill CALLS tetap berjalan sekali pada DB lama tanpa penanda", () => {
  const repo = tmpRepo("sc-evidence-backfill-");
  try {
    const db = openDb(repo);
    db.exec(`INSERT INTO files(path, language, hash, size) VALUES ('a.ts','typescript','h',1)`);
    db.exec(`INSERT INTO symbols(file_id, name, type) VALUES (1,'foo','function')`);
    db.exec(
      `INSERT INTO relationships(source_id, target_id, relationship_type, confidence, evidence)
       VALUES (1, 1, 'CALLS', 0.9, 'EXTRACTED')`
    );
    // Buang penanda supaya kondisi "belum pernah di-backfill" tersimulasikan.
    db.exec(`DELETE FROM meta WHERE key LIKE 'migration_calls_evidence%'`);
    db.close();

    const db2 = openDb(repo);
    const row = db2
      .prepare(`SELECT evidence FROM relationships WHERE relationship_type='CALLS'`)
      .get() as { evidence: string };
    assert.equal(row.evidence, "AMBIGUOUS", "DB lama tanpa penanda harus di-backfill");
    db2.close();
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Bug #5 — --no-refresh tidak influential di 4 dari 5 command
// ---------------------------------------------------------------------------

test("skipRefresh mengenali kedua bentuk flag", () => {
  // Bentuk programatik (test / pemanggilan internal).
  assert.equal(skipRefresh({ noRefresh: true }), true);
  assert.equal(skipRefresh({ noRefresh: false }), false);
  // Bentuk Commander: `--no-refresh` → { refresh: false }.
  assert.equal(skipRefresh({ refresh: false }), true);
  assert.equal(skipRefresh({ refresh: true }), false);
  // Absent / default → tetap refresh.
  assert.equal(skipRefresh(undefined), false);
  assert.equal(skipRefresh({}), false);
});

// ---------------------------------------------------------------------------
// Bug #6 — command injection lewat nama file terindeks
// ---------------------------------------------------------------------------

test("test runner memakai argv terpisah, bukan string untuk di-split", () => {
  const repo = tmpRepo("sc-runner-argv-");
  try {
    fs.writeFileSync(
      path.join(repo, "package.json"),
      JSON.stringify({ scripts: { test: "vitest run" } })
    );
    // Nama file bermetakarakter shell dan mengandung spasi.
    const files = ["tests/a.test.ts", "tests/b; rm -rf x;.test.ts", "tests/c d.test.ts"];
    const plan = detectTestRunnerPlan(repo, files);
    assert.ok(plan, "harus menemukan runner");

    // Setiap file tetap satu elemen argv — tidak ada yang terpecah jadi token.
    for (const f of files) {
      assert.ok(
        plan.argv.includes(f),
        `file harus jadi satu argumen utuh, bukan dipecah: ${JSON.stringify(f)}`
      );
    }
    // Metakarakter tidak pernah menjadi elemen argv tersendiri → tidak ada
    // yang bisa dieksekusi sebagai perintah terpisah oleh shell.
    assert.ok(!plan.argv.includes(";"));
    assert.ok(!plan.argv.includes("rm"));
    // Perintah yang ditampilkan tetap bisa di-copy-paste (tanpa sufiks .cmd).
    assert.equal(plan.command, `npx vitest run ${files.join(" ")}`);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("argv test runner memakai shim .cmd di Windows agar shell:false aman", () => {
  const repo = tmpRepo("sc-runner-win-");
  try {
    fs.writeFileSync(
      path.join(repo, "package.json"),
      JSON.stringify({ scripts: { test: "vitest run" } })
    );
    const plan = detectTestRunnerPlan(repo, ["tests/a.test.ts"]);
    assert.ok(plan);
    if (process.platform === "win32") {
      // npx/npm adalah shim .cmd; tanpa suffix, `shell:false` gagal dijalankan.
      assert.match(plan.argv[0], /^npx(\.cmd)?$/);
      if (plan.argv[0] === "npx") {
        assert.fail("di Windows argv harus memakai npx.cmd supaya shell:false bekerja");
      }
    } else {
      assert.equal(plan.argv[0], "npx");
    }
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Bug #4 — off-by-one git: `A..B` men-exclude A sehingga commit tertua hilang
// ---------------------------------------------------------------------------

test("sinkron riwayat mengindeks commit tertua (bukan kehilangan lewat A..B)", () => {
  const repo = tmpRepo("sc-hist-range-");
  try {
    git(repo, "init", "-q");
    git(repo, "config", "user.email", "t@t.t");
    git(repo, "config", "user.name", "T");

    const shas: string[] = [];
    for (let i = 1; i <= 5; i++) {
      fs.writeFileSync(path.join(repo, "f.txt"), `v${i}\n`);
      git(repo, "add", "-A");
      git(repo, "commit", "-q", "-m", `c${i}`);
      shas.push(git(repo, "rev-parse", "HEAD").trim());
    }

    const db = openDb(repo);
    const first = ensureHistoryIndex(db, repo);
    assert.equal(first.available, true, "repo git harus terdeteksi");
    assert.ok(first.indexed >= 5, `harus mengindeks >=5 commit, dapat ${first.indexed}`);

    const indexed = new Set(
      (db.prepare(`SELECT sha FROM commits`).all() as { sha: string }[]).map((r) => r.sha)
    );
    // Commit TERTUA harus ada. Dengan `${oldest}..${newest}` oldest ter-exclude
    // dari `git log`, sehingga hilang di setiap sync inkremental.
    assert.ok(
      indexed.has(shas[4]),
      "commit tertua harus terindeks — sebelumnya hilang karena `A..B` men-exclude A"
    );

    // Sync kedua: tidak menambah commit baru, tidak kehilangan apa pun.
    const second = ensureHistoryIndex(db, repo);
    assert.equal(second.indexed, 0, "sync kedua tidak boleh menambah commit baru");
    assert.ok(indexed.has(shas[0]) && indexed.has(shas[4]));
    db.close();
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});