import fs from "node:fs";
import path from "node:path";
import type {
  AdapterContext,
  AdapterFile,
  AdapterResult,
  FrameworkAdapter,
  QueryEdge,
} from "./types.js";
import {
  enclosingFunction,
  ensureAdapterSymbol,
  fileSymbolOf,
  insertRelation,
  lineOf,
} from "./types.js";
import { WEIGHT } from "../extract/types.js";

// Adapter Drizzle ORM: definisi tabel (`pgTable`/`sqliteTable`/`mysqlTable`)
// menjadi simbol `model`, dan dua gaya query menjadi edge QUERIES:
//   - relational: `db.query.users.findMany(`
//   - builder:    `db.select().from(users)`, `db.insert(users)`, ...
//
// Batasan eksplisit: relasi antar-tabel (references) tidak dipetakan;
// `sql` mentah dan RQB dinamis dilewati.

const TABLE_FNS = ["pgTable", "sqliteTable", "mysqlTable"];

const RELATIONAL_OPS = [
  "findMany",
  "findFirst",
  "findFirstOrThrow",
  "findUnique",
];

export interface DrizzleTable {
  /** Nama variabel JS, mis. `users`. */
  name: string;
  /** Nama tabel SQL, mis. `"users"`. */
  table: string;
  line: number;
}

/** `export const users = pgTable("users", {` → { name: `users`, table: `users` }. */
export function parseDrizzleTables(content: string): DrizzleTable[] {
  const out: DrizzleTable[] = [];
  const fns = TABLE_FNS.join("|");
  const re = new RegExp(
    `(?:export\\s+)?(?:const|let|var)\\s+(\\w+)\\s*=\\s*(?:${fns})\\s*\\(\\s*["'\`]([^"'\\\`]+)["'\`]`,
    "g"
  );
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    out.push({
      name: m[1],
      table: m[2],
      line: content.slice(0, m.index).split("\n").length,
    });
  }
  return out;
}

export interface DrizzleQuery {
  /** Nama variabel tabel yang dituju. */
  table: string;
  index: number;
}

/**
 * `db.query.users.findMany(` dan `db.select().from(users)` /
 * `db.insert(users)` / `db.update(users)` / `db.delete(users)`.
 */
export function parseDrizzleQueries(content: string): DrizzleQuery[] {
  const out: DrizzleQuery[] = [];
  const relOps = RELATIONAL_OPS.join("|");
  const relRe = new RegExp(`db\\s*\\.\\s*query\\s*\\.\\s*(\\w+)\\s*\\.\\s*(?:${relOps})\\s*\\(`, "g");
  let m: RegExpExecArray | null;
  while ((m = relRe.exec(content)) !== null) {
    out.push({ table: m[1], index: m.index });
  }
  // Builder: db.select()/insert()/update()/delete() → tabel dari `.from(x)` atau argumen.
  const builderRe = /db\s*\.\s*(select|selectDistinct|insert|update|delete)\b/g;
  while ((m = builderRe.exec(content)) !== null) {
    const op = m[1];
    const window = content.slice(m.index, m.index + 400);
    let tm: RegExpExecArray | null;
    if (op === "select" || op === "selectDistinct") {
      tm = /\.from\s*\(\s*(\w+)/.exec(window);
    } else {
      tm = /\(\s*(\w+)\s*[,)]/.exec(window);
    }
    if (tm) out.push({ table: tm[1], index: m.index });
  }
  return out;
}

function hasDrizzleMarker(content: string): boolean {
  if (
    content.includes("drizzle-orm") ||
    TABLE_FNS.some((f) => content.includes(`${f}(`)) ||
    /db\s*\.\s*query\s*\./.test(content)
  ) {
    return true;
  }
  // Bentuk builder tanpa import terlihat (`db.select().from(x)`):
  // aman diperiksa karena edge tetap butuh simbol model yang cocok.
  return /db\s*\.\s*(select|selectDistinct|insert|update|delete)\b/.test(content);
}

/** Turunkan edge QUERIES Drizzle untuk satu file (tanpa menulis DB). */
export function deriveDrizzleQueries(
  db: AdapterContext["db"],
  fileId: number,
  content: string
): QueryEdge[] {
  const out: QueryEdge[] = [];
  const fileSym = fileSymbolOf(db, fileId);
  if (!fileSym) return out;
  for (const q of parseDrizzleQueries(content)) {
    const target =
      findModelInFile(db, fileId, q.table) ?? findModelGlobal(db, q.table);
    if (!target) continue;
    const caller = enclosingFunction(db, fileId, lineOf(content, q.index)) ?? fileSym;
    if (caller === target) continue;
    out.push({
      callerId: caller,
      targetId: target,
      weight: WEIGHT.QUERIES,
      confidence: 0.85,
    });
  }
  return out;
}

/** Hapus + turunkan ulang edge QUERIES (anti-basi, pola nextjs). */
export function refreshDrizzleQueries(
  db: AdapterContext["db"],
  files: { fileId: number; rel: string; content: string }[]
): number {
  let n = 0;
  const del = db.prepare(
    `DELETE FROM relationships WHERE relationship_type = 'QUERIES' AND source_id IN (SELECT id FROM symbols WHERE file_id = ?)`
  );
  const ins = db.prepare(
    `INSERT INTO relationships(source_id, target_id, relationship_type, weight, confidence)
     VALUES (?, ?, 'QUERIES', ?, ?)`
  );
  for (const f of files) {
    if (!hasDrizzleMarker(f.content)) continue;
    del.run(f.fileId);
    for (const e of deriveDrizzleQueries(db, f.fileId, f.content)) {
      ins.run(e.callerId, e.targetId, e.weight, e.confidence);
      n++;
    }
  }
  return n;
}

function findModelInFile(
  db: AdapterContext["db"],
  fileId: number,
  name: string
): number | null {
  const row = db
    .prepare(
      `SELECT id FROM symbols WHERE file_id = ? AND name = ? AND type = 'model' LIMIT 1`
    )
    .get(fileId, name) as { id: number } | undefined;
  return row ? row.id : null;
}

function findModelGlobal(db: AdapterContext["db"], name: string): number | null {
  const rows = db.prepare(`SELECT id, name FROM symbols WHERE type = 'model'`).all() as {
    id: number;
    name: string;
  }[];
  const lower = name.toLowerCase();
  return rows.find((r) => r.name.toLowerCase() === lower)?.id ?? null;
}

export const drizzleAdapter: FrameworkAdapter = {
  id: "drizzle",
  label: "Drizzle ORM",
  detect: (files) =>
    files.some(
      (f) =>
        f.includes("drizzle") ||
        /(^|\/)drizzle\.config\.(ts|js|mjs)$/.test(f) ||
        /(^|\/)(db|drizzle)\/.*schema.*\.ts$/.test(f)
    ),
  // Pola path lemah (`src/adapters/drizzle.ts` ikut cocok) — konfirmasi isi:
  // path kuat (config/dir drizzle, skema db/) langsung lolos, sisanya butuh
  // dependensi drizzle di package.json.
  confirm: (repoRoot, files) => {
    if (
      files.some(
        (f) =>
          /(^|\/)drizzle\.config\.(ts|js|mjs)$/.test(f) ||
          /(^|\/)drizzle\//.test(f) ||
          /(^|\/)(db|drizzle)\/.*schema.*\.ts$/.test(f)
      )
    ) {
      return true;
    }
    try {
      const pkg = fs.readFileSync(path.join(repoRoot, "package.json"), "utf8");
      return (
        pkg.includes('"drizzle-orm"') ||
        pkg.includes('"drizzle-kit"') ||
        pkg.includes("'drizzle-orm'")
      );
    } catch {
      return false;
    }
  },
  relevant: (rel) => /\.(ts|tsx|js|jsx|mjs)$/.test(rel),
  apply(ctx: AdapterContext, files: AdapterFile[]): AdapterResult {
    let symbols = 0;
    let relations = 0;
    for (const f of files) {
      if (!hasDrizzleMarker(f.content)) continue;
      const fileSym = fileSymbolOf(ctx.db, f.fileId);
      if (!fileSym) continue;
      for (const t of parseDrizzleTables(f.content)) {
        const id = ensureAdapterSymbol(ctx.db, f.fileId, {
          name: t.name,
          type: "model",
          signature: `table ${t.name} ("${t.table}")`,
          startLine: t.line,
          endLine: t.line,
        });
        symbols++;
        insertRelation(ctx.db, fileSym, id, "CONTAINS", 1.0, 1.0);
        relations++;
      }
    }
    relations += refreshDrizzleQueries(
      ctx.db,
      files.map((f) => ({ fileId: f.fileId, rel: f.rel, content: f.content }))
    );
    return { symbols, relations };
  },
};
