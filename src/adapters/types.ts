import type { DatabaseSync } from "node:sqlite";
import type { SymbolType } from "../extract/types.js";

// Interface plugin framework adapter (FR-13). Setiap framework (Next.js,
// FastAPI, Express, ...) mengimplementasikan interface ini; inti tidak
// menanggung upkeep sintaks tiap framework — kontribusi komunitas cukup
// menambah file adapter + registrasi satu baris.

export interface AdapterSymbol {
  /** Nama simbol, mis. `GET /api/requests` atau `Request`. */
  name: string;
  type: SymbolType;
  signature: string;
  startLine: number;
  endLine: number;
}

export interface AdapterFile {
  fileId: number;
  rel: string;
  content: string;
}

export interface AdapterContext {
  db: DatabaseSync;
  repoRoot: string;
}

export interface AdapterResult {
  symbols: number;
  relations: number;
}

export interface FrameworkAdapter {
  /** Id unik, mis. `nextjs`, `prisma`. */
  id: string;
  label: string;
  /** True bila repo memakai framework ini (lihat daftar path repo). */
  detect(files: string[]): boolean;
  /**
   * Konfirmasi berbasis isi (opsional): dipanggil setelah detect() lolos,
   * untuk heuristik path yang lemah. Mis. adapter sendiri mengandung kata
   * "drizzle" — tanpa ini repo ScopeCairn terdeteksi memakai Drizzle.
   */
  confirm?(repoRoot: string, files: string[]): boolean;
  /** True bila file ini relevan untuk adapter ini. */
  relevant(rel: string): boolean;
  /** Sisipkan simbol + relasi milik adapter. */
  apply(ctx: AdapterContext, files: AdapterFile[]): AdapterResult;
}

/** Cari id simbol berdasarkan nama + (opsional) tipe. */
export function findSymbolId(
  db: DatabaseSync,
  name: string,
  types?: string[]
): number | null {
  const row =
    types && types.length > 0
      ? (db
          .prepare(
            `SELECT id FROM symbols WHERE name = ? AND type IN (${types.map(() => "?").join(",")}) LIMIT 1`
          )
          .get(name, ...types) as { id: number } | undefined)
      : (db.prepare(`SELECT id FROM symbols WHERE name = ? LIMIT 1`).get(name) as
          | { id: number }
          | undefined);
  return row ? row.id : null;
}

/** Id file-symbol untuk sebuah file_id. */
export function fileSymbolOf(db: DatabaseSync, fileId: number): number | null {
  const row = db
    .prepare(`SELECT id FROM symbols WHERE file_id = ? AND type = 'file'`)
    .get(fileId) as { id: number } | undefined;
  return row ? row.id : null;
}

/** Sisipkan simbol adapter bila belum ada di file ini; kembalikan id. */
export function ensureAdapterSymbol(
  db: DatabaseSync,
  fileId: number,
  s: AdapterSymbol
): number {
  const row = db
    .prepare(`SELECT id FROM symbols WHERE file_id = ? AND name = ? AND type = ? LIMIT 1`)
    .get(fileId, s.name, s.type) as { id: number } | undefined;
  if (row) return row.id;
  const r = db
    .prepare(
      `INSERT INTO symbols(file_id, name, type, signature, start_line, end_line)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(fileId, s.name, s.type, s.signature, s.startLine, s.endLine);
  return Number(r.lastInsertRowid);
}

export function insertRelation(
  db: DatabaseSync,
  sourceId: number,
  targetId: number,
  rel: string,
  weight: number,
  confidence: number
): void {
  if (sourceId === targetId) return;
  db.prepare(
    `INSERT INTO relationships(source_id, target_id, relationship_type, weight, confidence)
     VALUES (?, ?, ?, ?, ?)`
  ).run(sourceId, targetId, rel, weight, confidence);
}

export function lineOf(content: string, index: number): number {
  return content.slice(0, index).split("\n").length;
}

/** Fungsi pembungkus terdekat di atas sebuah baris (pola indexer). */
export function enclosingFunction(
  db: DatabaseSync,
  fileId: number,
  line: number
): number | null {
  const rows = db
    .prepare(
      `SELECT id, name FROM symbols WHERE file_id = ? AND type IN ('function','method','component') AND start_line <= ? ORDER BY start_line DESC LIMIT 5`
    )
    .all(fileId, line) as { id: number; name: string }[];
  return rows.length > 0 ? rows[0].id : null;
}
