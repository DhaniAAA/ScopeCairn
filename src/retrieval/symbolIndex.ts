import type { DatabaseSync } from "node:sqlite";
import { tokenizeIdentifier } from "./tokenize.js";

// Sinkronisasi FTS5 per file — dipanggil setelah simbol file (re)insert.
export function syncFileIndex(
  db: DatabaseSync,
  fileId: number,
  relPath: string
): void {
  db.prepare(
    `DELETE FROM symbol_index WHERE symbol_id IN (SELECT id FROM symbols WHERE file_id = ?)`
  ).run(fileId);
  // File symbol itself may not exist yet in odd states — guard.
  const rows = db
    .prepare(
      `SELECT id, name, type, signature, doc FROM symbols WHERE file_id = ?`
    )
    .all(fileId) as { id: number; name: string; type: string; signature: string; doc: string }[];
  const ins = db.prepare(
    `INSERT INTO symbol_index(symbol_id, tokens) VALUES (?, ?)`
  );
  for (const r of rows) {
    const toks = tokenizeIdentifier(`${r.name} ${r.signature} ${relPath} ${r.doc ?? ""}`).join(" ");
    if (toks) ins.run(r.id, toks);
  }
}

// Hapus baris yatim (simbol yang sudah dihapus cascade).
export function cleanupIndex(db: DatabaseSync): void {
  db.exec(
    `DELETE FROM symbol_index WHERE symbol_id NOT IN (SELECT id FROM symbols)`
  );
}

export interface SeedHit {
  symbolId: number;
  bm25: number;
}

// SEED: cocokkan token task (+ alias glossary) ke symbol_index via FTS5.
// Skor bm25 SQLite negatif (lebih negatif = lebih relevan) → normalisasi 0..1.
export function seedSearch(
  db: DatabaseSync,
  tokens: string[],
  limit = 30
): SeedHit[] {
  if (tokens.length === 0) return [];
  const q = tokens
    .map((t) => `"${t.replace(/"/g, "")}"`)
    .join(" OR ");
  let rows: { symbol_id: number; rank: number }[];
  try {
    const lim = Math.max(1, Math.min(500, Math.floor(limit) || 30));
    rows = db
      .prepare(
        `SELECT symbol_id, bm25(symbol_index) AS rank
         FROM symbol_index WHERE symbol_index MATCH ?
         ORDER BY rank LIMIT ${lim}`
      )
      .all(q) as { symbol_id: number; rank: number }[];
  } catch {
    return [];
  }
  if (rows.length === 0) return [];
  const worst = Math.min(...rows.map((r) => r.rank)); // most negative
  const range = Math.max(1e-9, 0 - worst + 1);
  return rows.map((r) => ({
    symbolId: r.symbol_id,
    bm25: Math.max(0, Math.min(1, (0 - r.rank + 0.5) / range)),
  }));
}
