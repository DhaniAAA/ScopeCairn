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
  // 100: query bervarian (stemming+glossary) punya lebih banyak term OR,
  // kandidat perlu lebih longgar sebelum RANK memangkas ke topN.
  limit = 100
): SeedHit[] {
  if (tokens.length === 0) return [];
  // Prefix query FTS5 (`term*`): naikkan recall untuk varian morfologi yang
  // belum tercakup stem (mis. token terpotong / akhiran beda sedikit).
  const prefixQ = (ts: string[]): string =>
    ts
      .map((t) => t.replace(/[^a-zA-Z0-9]/g, ""))
      .filter((t) => t.length >= 2)
      .map((t) => `${t}*`)
      .join(" OR ");
  const q = prefixQ(tokens);
  if (!q) return [];
  let rows: { symbol_id: number; rank: number }[] = [];
  const runFts = (query: string): { symbol_id: number; rank: number }[] => {
    try {
      const lim = Math.max(1, Math.min(500, Math.floor(limit) || 30));
      return db
        .prepare(
          `SELECT symbol_id, bm25(symbol_index) AS rank
           FROM symbol_index WHERE symbol_index MATCH ?
           ORDER BY rank LIMIT ${lim}`
        )
        .all(query) as { symbol_id: number; rank: number }[];
    } catch {
      return [];
    }
  };
  rows = runFts(q);
  if (rows.length === 0) {
    // Fallback typo-tolerant: variasi edit-distance 1 (hapus 1 char +
    // transposisi adjacent) untuk token panjang, lalu substring scan.
    const variants = new Set<string>();
    for (const t of tokens) {
      const p = t.replace(/[^a-zA-Z0-9]/g, "");
      if (p.length < 4) continue;
      for (let i = 0; i < p.length; i++) variants.add(p.slice(0, i) + p.slice(i + 1));
      for (let i = 0; i + 1 < p.length; i++) {
        const c = p.split("");
        const tmp = c[i];
        c[i] = c[i + 1];
        c[i + 1] = tmp;
        variants.add(c.join(""));
      }
    }
    if (variants.size > 0) {
      const vq = prefixQ([...variants]);
      if (vq) rows = runFts(vq);
    }
    if (rows.length === 0) {
      // Substring fallback: scan kolom tokens langsung (hanya saat 0 hit,
      // batasi 5000 baris) — cocokkan token sebagai substring.
      try {
        const trows = db
          .prepare(`SELECT symbol_id, tokens FROM symbol_index LIMIT 5000`)
          .all() as { symbol_id: number; tokens: string }[];
        const need = tokens
          .map((t) => t.replace(/[^a-zA-Z0-9]/g, "").toLowerCase())
          .filter((t) => t.length >= 3);
        if (need.length > 0) {
          const scored: { symbol_id: number; rank: number }[] = [];
          const seen = new Set<number>();
          for (const r of trows) {
            if (seen.has(r.symbol_id)) continue;
            const toks = r.tokens.toLowerCase();
            if (need.some((n) => toks.includes(n))) {
              scored.push({ symbol_id: r.symbol_id, rank: -1 });
              seen.add(r.symbol_id);
            }
            if (scored.length >= 100) break;
          }
          rows = scored;
        }
      } catch {
        // abaikan
      }
    }
  }
  if (rows.length === 0) return [];
  // Presisi: hitung token-task berbeda yang cocok per simbol. Seed yang
  // hanya cocok 1 token (mis. "add", "test") diturunkan ×0.6 agar tak
  // mengalahkan file yang cocok ≥2 konsep. Hanya bila task ≥4 token
  // (task pendek tak dituntut multi-cocok). Tanpa re-index: baca kolom
  // tokens yang sudah ada.
  const multi = new Map<number, number>();
  if (tokens.length >= 4) {
    try {
      const ids = rows.map((r) => r.symbol_id);
      const ph = ids.map(() => "?").join(",");
      const trows = db
        .prepare(`SELECT symbol_id, tokens FROM symbol_index WHERE symbol_id IN (${ph})`)
        .all(...ids) as { symbol_id: number; tokens: string }[];
      const tset = new Set(tokens);
      for (const t of trows) {
        const toks = new Set(t.tokens.split(" ").filter(Boolean));
        let n = 0;
        for (const tok of tset) if (toks.has(tok)) n++;
        multi.set(t.symbol_id, n);
      }
    } catch {
      // abaikan — pakai skor mentah
    }
  }
  const worst = Math.min(...rows.map((r) => r.rank)); // most negative
  const range = Math.max(1e-9, 0 - worst + 1);
  return rows.map((r) => {
    const bm25 = Math.max(0, Math.min(1, (0 - r.rank + 0.5) / range));
    // Lunak (×0.85) dan hanya untuk cocok-tunggal yang LEMAH (bm25 < 0.7):
    // istilah langka yang cocok tunggal (mis. "health" di doc) informatif
    // dan dipertahankan; junk umum ("add", "test") yang diturunkan.
    const weakSingle =
      multi.size > 0 && (multi.get(r.symbol_id) ?? 0) < 2 && bm25 < 0.7;
    return { symbolId: r.symbol_id, bm25: bm25 * (weakSingle ? 0.85 : 1) };
  });
}
