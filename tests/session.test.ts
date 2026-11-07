import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  MAX_SESSION_CHARS,
  SESSION_REL_PATH,
  detectSecrets,
  ensureSessionGitignored,
  saveSession,
  loadSession,
  cmdSessionSave,
  cmdSessionLoad,
} from "../src/commands/session.js";

function git(repo: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd: repo,
    encoding: "utf8",
    timeout: 10000,
    stdio: ["ignore", "pipe", "ignore"],
  });
}

function createGitRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sc-session-"));
  git(dir, ["init"]);
  git(dir, ["config", "user.email", "dev@example.com"]);
  git(dir, ["config", "user.name", "Dev"]);
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.writeFileSync(path.join(dir, "src", "index.ts"), "export const v = 1;\n", "utf8");
  git(dir, ["add", "."]);
  git(dir, ["commit", "-m", "feat: initial commit"]);
  return dir;
}

test("saveSession & loadSession: roundtrip 5 bagian, updated_at, git_head, dan .gitignore otomatis", () => {
  const repo = createGitRepo();
  try {
    // Sebelum disimpan, loadSession harus melaporkan exists: false tanpa error
    const before = loadSession(repo);
    assert.equal(before.exists, false);
    assert.equal(before.raw, null);
    assert.equal(before.commitsSinceSave, 0);
    assert.deepEqual(before.changedFiles, []);

    const saved = saveSession(repo, {
      working: "Implementasi modul pembayaran",
      decisions: "Memakai tulis atomik via temp file + rename",
      next: "Menambah test batas karakter dan deteksi rahasia",
      blockers: "Menunggu konfirmasi skema webhook",
      files: ["src/index.ts", "src/payment.ts"],
    });

    assert.equal(saved.ok, true);
    assert.equal(saved.path, SESSION_REL_PATH);
    assert.ok(saved.charCount > 0 && saved.charCount <= MAX_SESSION_CHARS);
    assert.ok(saved.updatedAt && /^\d{4}-\d{2}-\d{2}T/.test(saved.updatedAt));
    assert.ok(saved.gitHead && saved.gitHead.length >= 7);

    // Pastikan tidak ada file .tmp yang tertinggal di .scopecairn/
    const scEntries = fs.readdirSync(path.join(repo, ".scopecairn"));
    assert.ok(
      !scEntries.some((name) => name.includes(".tmp.")),
      `tidak boleh ada file sementara tertinggal: ${scEntries.join(", ")}`
    );

    // Pastikan .scopecairn/session.md masuk .gitignore secara default dan diabaikan git
    const rootGitignore = fs.readFileSync(path.join(repo, ".gitignore"), "utf8");
    assert.ok(
      rootGitignore.includes(".scopecairn/session.md"),
      ".gitignore harus memuat .scopecairn/session.md"
    );
    const ignoredCheck = git(repo, ["check-ignore", ".scopecairn/session.md"]).trim();
    assert.equal(ignoredCheck, ".scopecairn/session.md");

    // Load kembali dan verifikasi seluruh bagian
    const loaded = loadSession(repo);
    assert.equal(loaded.exists, true);
    assert.equal(loaded.updatedAt, saved.updatedAt);
    assert.equal(loaded.savedGitHead, saved.gitHead);
    assert.equal(loaded.currentGitHead, saved.gitHead);
    assert.equal(loaded.commitsSinceSave, 0);
    assert.deepEqual(loaded.changedFiles, []);
    assert.equal(loaded.sections.working, "Implementasi modul pembayaran");
    assert.equal(loaded.sections.decisions, "Memakai tulis atomik via temp file + rename");
    assert.equal(loaded.sections.nextSteps, "Menambah test batas karakter dan deteksi rahasia");
    assert.equal(loaded.sections.blockers, "Menunggu konfirmasi skema webhook");
    assert.deepEqual(loaded.sections.keyFiles, ["src/index.ts", "src/payment.ts"]);

    // Partial update hanya mengubah bagian yang dikirim, bagian lain tetap terjaga
    const updated = saveSession(repo, {
      working: "Menyelesaikan integrasi webhook",
      blockers: "Tidak ada",
    });
    assert.equal(updated.ok, true);
    const loadedAfterPartial = loadSession(repo);
    assert.equal(loadedAfterPartial.sections.working, "Menyelesaikan integrasi webhook");
    assert.equal(loadedAfterPartial.sections.blockers, "Tidak ada");
    assert.equal(
      loadedAfterPartial.sections.decisions,
      "Memakai tulis atomik via temp file + rename"
    );
    assert.deepEqual(loadedAfterPartial.sections.keyFiles, ["src/index.ts", "src/payment.ts"]);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("loadSession melaporkan jumlah commit baru dan file yang berubah sejak save terakhir", () => {
  const repo = createGitRepo();
  try {
    const saved = saveSession(repo, {
      working: "Refactoring modul auth",
      decisions: "Tetap memakai SQLite",
      next: "Uji regresi",
      blockers: "-",
      files: "src/index.ts",
    });
    assert.equal(saved.ok, true);

    // Buat 2 commit baru yang mengubah file berbeda + 1 perubahan dirty di working tree
    fs.writeFileSync(path.join(repo, "src", "index.ts"), "export const v = 2;\n", "utf8");
    git(repo, ["add", "src/index.ts"]);
    git(repo, ["commit", "-m", "feat: bump v to 2"]);

    fs.writeFileSync(path.join(repo, "src", "auth.ts"), "export function login() { return true; }\n", "utf8");
    git(repo, ["add", "src/auth.ts"]);
    git(repo, ["commit", "-m", "feat: add auth module"]);

    fs.writeFileSync(path.join(repo, "src", "uncommitted.ts"), "export const dirty = true;\n", "utf8");

    const loaded = loadSession(repo);
    assert.equal(loaded.exists, true);
    assert.equal(loaded.commitsSinceSave, 2, "harus melaporkan tepat 2 commit sejak save terakhir");
    assert.notEqual(loaded.savedGitHead, loaded.currentGitHead);
    assert.deepEqual(loaded.changedFiles, [
      "src/auth.ts",
      "src/index.ts",
      "src/uncommitted.ts",
    ]);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("saveSession menolak ukuran > 4.000 karakter dan mempertahankan file sesi lama", () => {
  const repo = createGitRepo();
  try {
    const initial = saveSession(repo, {
      working: "Sesi awal yang valid",
      decisions: "Keputusan awal",
    });
    assert.equal(initial.ok, true);

    // Buat teks > 4000 karakter
    const oversizedText = "x".repeat(MAX_SESSION_CHARS + 50);
    const rejected = saveSession(repo, {
      working: oversizedText,
    });
    assert.equal(rejected.ok, false);
    assert.ok(rejected.charCount > MAX_SESSION_CHARS);
    assert.ok(
      rejected.error?.includes("4000"),
      `pesan error harus menyebut batas 4000 karakter, got: ${rejected.error}`
    );

    // Pastikan sesi lama tidak tertimpa
    const loaded = loadSession(repo);
    assert.equal(loaded.sections.working, "Sesi awal yang valid");
    assert.equal(loaded.sections.decisions, "Keputusan awal");
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("detectSecrets & saveSession menolak berbagai pola API key, token, dan credential", () => {
  const repo = createGitRepo();
  try {
    const validSave = saveSession(repo, {
      working: "Sesi bersih tanpa rahasia",
    });
    assert.equal(validSave.ok, true);

    const samples: Array<{ name: string; text: string }> = [
      {
        name: "OpenAI key",
        text: "Menggunakan key " + "sk-proj-" + "AbCdEfGhIjKlMnOpQrStUvWxYz123456" + " untuk request",
      },
      {
        name: "GitHub PAT",
        text: "Token rilis " + "ghp_" + "1234567890abcdef1234567890abcdef1234",
      },
      {
        name: "AWS Access Key",
        text: "Kredensial S3 " + "AKIA" + "IOSFODNN7EXAMPLE" + " dipakai di env",
      },
      {
        name: "Slack token",
        text: "Notifikasi bot " + "xoxb-" + "123456789012-1234567890123-" + "AbCdEfGhIjKlMnOpQrStUvWx",
      },
      {
        name: "Private Key PEM",
        text: "-----BEGIN RSA PRIVATE" + " KEY-----\nMIIEpAIBAAKCAQEA...",
      },
      {
        name: "Generic api_key assignment",
        text: 'Konfigurasi sementara api_key = "super_secret_token_99887766"',
      },
      {
        name: "Bearer token",
        text: "Authorization: " + "Bearer " + "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c",
      },
    ];

    for (const s of samples) {
      const detected = detectSecrets(s.text);
      assert.ok(detected.length > 0, `harus mendeteksi pola rahasia untuk ${s.name}`);

      const res = saveSession(repo, { decisions: s.text });
      assert.equal(res.ok, false, `saveSession harus menolak ${s.name}`);
      assert.ok(
        res.error?.includes("pola rahasia"),
        `pesan error untuk ${s.name} harus menjelaskan alasan pola rahasia: ${res.error}`
      );
    }

    // Pastikan sesi lama tidak rusak oleh percobaan simpan yang ditolak
    const afterAttempts = loadSession(repo);
    assert.equal(afterAttempts.sections.working, "Sesi bersih tanpa rahasia");
    assert.equal(afterAttempts.sections.decisions, "-");
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("cmdSessionSave & cmdSessionLoad mendukung --file, --json, dan validasi input kosong", () => {
  const repo = createGitRepo();
  const logs: string[] = [];
  const errors: string[] = [];
  const origLog = console.log;
  const origErr = console.error;
  const origExit = process.exitCode;
  console.log = (...args: unknown[]) => logs.push(args.map(String).join(" "));
  console.error = (...args: unknown[]) => errors.push(args.map(String).join(" "));

  try {
    // 1. Panggilan kosong harus ditolak dengan exitCode = 1
    process.exitCode = 0;
    cmdSessionSave(repo, { json: true });
    assert.equal(process.exitCode, 1);
    const emptyRes = JSON.parse(logs[0]) as { ok: boolean; error: string };
    assert.equal(emptyRes.ok, false);
    assert.ok(emptyRes.error.includes("kosong"));

    // 2. Simpan dari --file markdown dan muat lewat cmdSessionLoad --json
    logs.length = 0;
    process.exitCode = 0;
    const inputPath = path.join(repo, "draft-session.md");
    fs.writeFileSync(
      inputPath,
      `## Sedang Dikerjakan\nIntegrasi CLI session\n\n## Keputusan\nPakai tulis atomik\n\n## Langkah Berikutnya\nTahap 3\n\n## Blocker\n-\n\n## File Penting\n- src/commands/session.ts\n`,
      "utf8"
    );
    cmdSessionSave(repo, { file: "draft-session.md", json: true });
    assert.equal(process.exitCode, 0);
    const savedJson = JSON.parse(logs[0]) as { ok: boolean; charCount: number };
    assert.equal(savedJson.ok, true);

    logs.length = 0;
    cmdSessionLoad(repo, { json: true });
    const loadedJson = JSON.parse(logs[0]) as {
      exists: boolean;
      commitsSinceSave: number;
      sections: { working: string; keyFiles: string[] };
    };
    assert.equal(loadedJson.exists, true);
    assert.equal(loadedJson.sections.working, "Integrasi CLI session");
    assert.deepEqual(loadedJson.sections.keyFiles, ["src/commands/session.ts"]);

    // 3. ensureSessionGitignored bersifat idempoten (tidak menduplikasi baris)
    ensureSessionGitignored(repo);
    ensureSessionGitignored(repo);
    const ignoreLines = fs
      .readFileSync(path.join(repo, ".gitignore"), "utf8")
      .split(/\r?\n/)
      .filter((l) => l.trim() === ".scopecairn/session.md");
    assert.equal(ignoreLines.length, 1, ".scopecairn/session.md hanya boleh tertulis sekali di .gitignore");
  } finally {
    console.log = origLog;
    console.error = origErr;
    process.exitCode = origExit;
    fs.rmSync(repo, { recursive: true, force: true });
  }
});
