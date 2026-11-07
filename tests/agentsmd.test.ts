// Test Project Rules (AGENTS.md): loader + render di context.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  findAgentsMd,
  loadProjectRules,
  demoteHeadings,
  stripManagedBlock,
} from "../src/scope/agentsmd.js";
import { buildContext } from "../src/retrieval/contextBuilder.js";
import { DEFAULT_CONFIG } from "../src/retrieval/config.js";

function tmpRepo(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentsmd-"));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  return dir;
}

function memDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE files (id INTEGER PRIMARY KEY, path TEXT UNIQUE, language TEXT, hash TEXT, size INTEGER);
    CREATE TABLE symbols (id INTEGER PRIMARY KEY, file_id INTEGER, name TEXT, type TEXT, signature TEXT, start_line INTEGER, end_line INTEGER);
    CREATE TABLE relationships (source_id INTEGER, target_id INTEGER, relationship_type TEXT, weight REAL, confidence REAL, evidence TEXT);
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `);
  return db;
}

const CLS = {
  complexity: "COMPLEX" as const,
  estimatedFiles: 3,
  modules: ["src"],
  reasons: ["uji"],
  highFanin: [] as string[],
  protectedHits: [] as string[],
};

const RESULT = {
  tokens: [],
  seeds: [],
  ranked: [],
  config: DEFAULT_CONFIG,
  gitAvailable: false,
};

test("loader menemukan AGENTS.md di root", () => {
  const dir = tmpRepo({ "AGENTS.md": "# Aturan\n- Pakai bahasa Indonesia.\n" });
  try {
    assert.equal(findAgentsMd(dir), "AGENTS.md");
    const rules = loadProjectRules(dir);
    assert.ok(rules);
    assert.equal(rules.path, "AGENTS.md");
    assert.ok(rules.content.includes("bahasa Indonesia"));
    assert.equal(rules.truncated, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("loader return null bila tak ada file atau kosong", () => {
  const dir = tmpRepo({ "src/a.ts": "const x = 1;\n" });
  try {
    assert.equal(findAgentsMd(dir), null);
    assert.equal(loadProjectRules(dir), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  const empty = tmpRepo({ "AGENTS.md": "   \n" });
  try {
    assert.equal(loadProjectRules(empty), null);
  } finally {
    fs.rmSync(empty, { recursive: true, force: true });
  }
});

test("loader memotong isi melebihi anggaran", () => {
  const dir = tmpRepo({ "AGENTS.md": "x".repeat(5000) });
  try {
    const rules = loadProjectRules(dir, 1000);
    assert.ok(rules);
    assert.equal(rules.truncated, true);
    assert.ok(rules.content.length <= 1000);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("context COMPLEX memuat seksi Project Rules", () => {
  const db = memDb();
  try {
    const built = buildContext(db, "tambah fitur", RESULT, CLS, {
      repoRoot: ".",
      projectRules: { path: "AGENTS.md", content: "- Pakai bahasa Indonesia.", truncated: false },
    });
    assert.ok(built.markdown.includes("## Project Rules"));
    assert.ok(built.markdown.includes("AGENTS.md"));
    assert.ok(built.markdown.includes("bahasa Indonesia"));
    // Aturan tampil sebelum daftar file agar terbaca lebih dulu.
    assert.ok(built.markdown.indexOf("## Project Rules") < built.markdown.indexOf("## Relevant Files"));
  } finally {
    db.close();
  }
});

test("seksi disembunyikan bila tak ada AGENTS.md + catatan potong bila truncated", () => {
  const db = memDb();
  try {
    const plain = buildContext(db, "tambah fitur", RESULT, CLS, { repoRoot: "." });
    assert.ok(!plain.markdown.includes("## Project Rules"));
    const cut = buildContext(db, "tambah fitur", RESULT, CLS, {
      repoRoot: ".",
      projectRules: { path: "AGENTS.md", content: "aturan", truncated: true },
    });
    assert.ok(cut.markdown.includes("dipotong ke anggaran"));
  } finally {
    db.close();
  }
});

test("demoteHeadings menurunkan level heading dan mengabaikan code fence", () => {
  const input = [
    "# Judul Utama",
    "## Sub Bab",
    "### Detil",
    "```bash",
    "# komentar bash tidak boleh diubah",
    "## komentar kedua",
    "```",
    "normal text",
  ].join("\n");

  const expected = [
    "### Judul Utama",
    "#### Sub Bab",
    "##### Detil",
    "```bash",
    "# komentar bash tidak boleh diubah",
    "## komentar kedua",
    "```",
    "normal text",
  ].join("\n");

  assert.equal(demoteHeadings(input), expected);
});

test("loader mengembalikan null bila maxChars <= 0", () => {
  const dir = tmpRepo({ "AGENTS.md": "aturan penting" });
  try {
    assert.equal(loadProjectRules(dir, 0), null);
    assert.equal(loadProjectRules(dir, -10), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("loader menangani file besar tanpa membaca seluruhnya ke memori", () => {
  const dir = tmpRepo({ "AGENTS.md": "baris aturan\n".repeat(2000) });
  try {
    const rules = loadProjectRules(dir, 1000);
    assert.ok(rules);
    assert.equal(rules.truncated, true);
    assert.ok(rules.content.length <= 1000);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("context merender Project Rules dengan heading diturunkan agar tidak memecah delimiter ##", () => {
  const db = memDb();
  try {
    const built = buildContext(db, "tambah fitur", RESULT, CLS, {
      repoRoot: ".",
      projectRules: {
        path: "AGENTS.md",
        content: "# Aturan\n## Wajib\n- ikuti aturan.",
        truncated: false,
      },
    });
    // Di dalam context, ## Project Rules adalah satu-satunya heading level 2 di seksi itu
    assert.ok(built.markdown.includes("## Project Rules"));
    assert.ok(built.markdown.includes("### Aturan"));
    assert.ok(built.markdown.includes("#### Wajib"));
    assert.ok(!built.markdown.includes("\n## Wajib"));
  } finally {
    db.close();
  }
});

test("stripManagedBlock membuang blok managed dan mempertahankan konten asli", () => {
  const userText = "# Catatan Proyek\n- aturan asli.";
  const combinedId = `${userText}\n\n<!-- scopecairn:managed -->\n# ScopeCairn — Protokol Engineering Otomatis\n...tersimpan dengan bukti dan ikut terbaca di setiap context berikutnya.\n`;
  assert.equal(stripManagedBlock(combinedId), userText);

  const combinedEn = `${userText}\n\n<!-- scopecairn:managed -->\n# ScopeCairn — Automated Engineering Protocol\n...stored with evidence and included in all future contexts.\n`;
  assert.equal(stripManagedBlock(combinedEn), userText);

  assert.equal(stripManagedBlock(userText), userText);
});

test("loadProjectRules mengabaikan blok <!-- scopecairn:managed --> milik ScopeCairn", () => {
  const dir = tmpRepo({
    "AGENTS.md":
      "# Catatan Proyek User\n- aturan arsitektur penting\n\n<!-- scopecairn:managed -->\n# ScopeCairn — Automated Engineering Protocol\n...stored with evidence and included in all future contexts.\n",
  });
  try {
    const rules = loadProjectRules(dir);
    assert.ok(rules);
    assert.ok(rules.content.includes("# Catatan Proyek User"));
    assert.ok(rules.content.includes("aturan arsitektur penting"));
    assert.ok(!rules.content.includes("ScopeCairn — Automated Engineering Protocol"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("loadProjectRules mengembalikan null jika AGENTS.md hanya berisi blok managed ScopeCairn", () => {
  const dir = tmpRepo({
    "AGENTS.md":
      "<!-- scopecairn:managed -->\n# ScopeCairn — Automated Engineering Protocol\n...stored with evidence and included in all future contexts.\n",
  });
  try {
    assert.equal(loadProjectRules(dir), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

