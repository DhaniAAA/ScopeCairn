// Regresi integritas indeks: re-scan satu file TIDAK boleh menghapus edge
// yang berasal dari file lain yang tidak berubah.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb } from "../src/db.js";
import { scanRepository } from "../src/scanner.js";

function tmpRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sc-cascade-"));
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  return dir;
}

/** Hitung edge yang sumbernya di `srcFile` dan targetnya ada di `dstFile`. */
function crossEdges(repo: string, srcFile: string, dstFile: string): number {
  const db = openDb(repo);
  try {
    const row = db
      .prepare(
        `SELECT COUNT(*) AS n
           FROM relationships r
           JOIN symbols s ON s.id = r.source_id
           JOIN symbols t ON t.id = r.target_id
          WHERE s.file_id = (SELECT id FROM files WHERE path = ?)
            AND t.file_id = (SELECT id FROM files WHERE path = ?)`
      )
      .get(srcFile, dstFile) as { n: number };
    return row.n;
  } finally {
    db.close();
  }
}

function symbolIds(repo: string, file: string, name: string): number[] {
  const db = openDb(repo);
  try {
    return (
      db
        .prepare(
          `SELECT s.id FROM symbols s
             JOIN files f ON f.id = s.file_id
            WHERE f.path = ? AND s.name = ? ORDER BY s.id`
        )
        .all(file, name) as { id: number }[]
    ).map((r) => r.id);
  } finally {
    db.close();
  }
}

test("re-scan file yang diimpor tidak menghapus edge dari pengimpornya", async () => {
  const repo = tmpRepo();
  try {
    fs.writeFileSync(
      path.join(repo, "src", "a.ts"),
      `export function target(): number { return 1; }\n`
    );
    fs.writeFileSync(
      path.join(repo, "src", "b.ts"),
      `import { target } from "./a.js";\nexport function caller(): number { return target(); }\n`
    );

    await scanRepository(repo);

    const before = crossEdges(repo, "src/b.ts", "src/a.ts");
    assert.ok(before > 0, `harus ada edge b->a setelah scan pertama, dapat ${before}`);

    // Edit HANYA a.ts — b.ts tidak berubah sama sekali.
    fs.writeFileSync(
      path.join(repo, "src", "a.ts"),
      `// komentar baru\n` + `export function target(): number { return 1; }\n`
    );

    await scanRepository(repo);

    const after = crossEdges(repo, "src/b.ts", "src/a.ts");
    assert.equal(
      after,
      before,
      "edge dari file yang tidak berubah harus tetap ada — cascade delete lama menghapusnya"
    );
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("ID simbol stabil lintas re-index (edge inbound tidak jadi yatim)", async () => {
  const repo = tmpRepo();
  try {
    fs.writeFileSync(
      path.join(repo, "src", "a.ts"),
      `export function target(): number { return 1; }\n`
    );
    await scanRepository(repo);
    const firstIds = symbolIds(repo, "src/a.ts", "target");
    assert.equal(firstIds.length, 1);

    // Edit isi tapi nama & tipe simbol tetap sama.
    fs.writeFileSync(
      path.join(repo, "src", "a.ts"),
      `// diubah\n` + `export function target(): number { return 42; }\n`
    );
    await scanRepository(repo);
    const secondIds = symbolIds(repo, "src/a.ts", "target");

    assert.deepEqual(
      secondIds,
      firstIds,
      "simbol yang bertahan harus mempertahankan ID-nya (upsert, bukan delete+insert)"
    );
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("simbol yang benar-benar dihapus hilang beserta edge-nya", async () => {
  const repo = tmpRepo();
  try {
    fs.writeFileSync(
      path.join(repo, "src", "a.ts"),
      `export function keep(): number { return 1; }\n` +
        `export function gone(): number { return 2; }\n`
    );
    fs.writeFileSync(
      path.join(repo, "src", "b.ts"),
      `import { gone } from "./a.js";\nexport function caller(): number { return gone(); }\n`
    );
    await scanRepository(repo);
    assert.ok(crossEdges(repo, "src/b.ts", "src/a.ts") > 0);

    // `gone` dihapus dari a.ts, tapi `keep` tetap.
    fs.writeFileSync(
      path.join(repo, "src", "a.ts"),
      `export function keep(): number { return 1; }\n`
    );
    await scanRepository(repo);

    assert.equal(symbolIds(repo, "src/a.ts", "gone").length, 0, "gone harus hilang");
    assert.equal(symbolIds(repo, "src/a.ts", "keep").length, 1, "keep harus bertahan");
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

/** Hitung edge duplikat (source, target, type) yang muncul lebih dari sekali. */
function duplicateEdgeGroups(repo: string): number {
  const db = openDb(repo);
  try {
    return (
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM (
             SELECT source_id, target_id, relationship_type
               FROM relationships
              GROUP BY source_id, target_id, relationship_type
             HAVING COUNT(*) > 1)`
        )
        .get() as { n: number }
    ).n;
  } finally {
    db.close();
  }
}

/** Jumlah total edge di repo. */
function edgeCount(repo: string): number {
  const db = openDb(repo);
  try {
    return (db.prepare(`SELECT COUNT(*) AS n FROM relationships`).get() as { n: number }).n;
  } finally {
    db.close();
  }
}

test("re-scan berulang tidak menumpuk edge duplikat", async () => {
  const repo = tmpRepo();
  try {
    fs.writeFileSync(
      path.join(repo, "src", "a.ts"),
      `export function helper(x: number): number { return x + 1; }\n`
    );
    // SATU call site saja — dua edge CALLS dengan pasangan yang sama pasti
    // berarti insert berulang, bukan dua titik pemanggilan yang sah.
    fs.writeFileSync(
      path.join(repo, "src", "b.ts"),
      `import { helper } from "./a.js";\nexport function caller(): number { return helper(1); }\n`
    );

    await scanRepository(repo);
    assert.equal(duplicateEdgeGroups(repo), 0, "scan pertama tidak boleh duplikat");
    const relsFirst = edgeCount(repo);

    // Scan ulang berkali-kali dengan file yang tidak berubah → stabil.
    await scanRepository(repo);
    await scanRepository(repo);

    assert.equal(duplicateEdgeGroups(repo), 0, "tidak boleh ada edge duplikat");
    assert.equal(edgeCount(repo), relsFirst, "jumlah edge harus stabil antar scan");
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("mutasi scan benar-benar di-COMMIT (dibaca koneksi baru)", async () => {
  const repo = tmpRepo();
  try {
    fs.writeFileSync(
      path.join(repo, "src", "a.ts"),
      `export function target(): number { return 1; }\n`
    );

    await scanRepository(repo);

    // Koneksi BARU — kalau BEGIN dijalankan tanpa COMMIT, data scan ini
    // tidak akan terlihat (atau transaksi masih terkunci).
    const db = openDb(repo);
    try {
      const files = db.prepare(`SELECT COUNT(*) AS n FROM files`).get() as { n: number };
      const syms = db.prepare(`SELECT COUNT(*) AS n FROM symbols`).get() as { n: number };
      assert.ok(files.n > 0, "baris files harus terlihat setelah COMMIT");
      assert.ok(syms.n > 0, "baris symbols harus terlihat setelah COMMIT");

      // Penanda penutup fase harus ikut ter-commit.
      const lastScan = db
        .prepare(`SELECT value FROM meta WHERE key = 'last_scan'`)
        .get() as { value: string } | undefined;
      assert.ok(lastScan?.value, "meta.last_scan harus ter-commit");
    } finally {
      db.close();
    }
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});