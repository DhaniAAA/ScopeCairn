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
import { withSyntaxTree } from "../treesitter.js";
import { grammarForPath } from "../extract/treeSitter.js";
import type { Node } from "web-tree-sitter";

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
function drizzleTables(content: string, grammar: string): DrizzleTable[] {
  return withSyntaxTree(grammar, content, (root) => {
    const out: DrizzleTable[] = [];
    const visit = (node: Node) => {
      if (node.type === "variable_declarator") {
        const name = node.childForFieldName("name");
        const call = node.childForFieldName("value");
        const first = call?.childForFieldName("arguments")?.namedChildren[0];
        if (name?.type === "identifier" && call?.type === "call_expression" &&
            TABLE_FNS.includes(call.childForFieldName("function")?.text ?? "") &&
            first && (first.type === "string" || first.type === "template_string") && first.text.length > 2 &&
            !first.namedChildren.some((child) => child?.type === "template_substitution")) {
          out.push({ name: name.text, table: first.text.slice(1, -1), line: node.startPosition.row + 1 });
        }
      }
      for (const child of node.namedChildren) if (child) visit(child);
    };
    visit(root);
    return out;
  });
}

export function parseDrizzleTables(content: string): DrizzleTable[] {
  return drizzleTables(content, "typescript");
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
function member(node: Node | null | undefined, property: string): Node | null {
  return node?.type === "member_expression" && node.childForFieldName("property")?.text === property
    ? node.childForFieldName("object") : null;
}

function drizzleQueries(content: string, grammar: string): DrizzleQuery[] {
  return withSyntaxTree(grammar, content, (root) => {
    const out: DrizzleQuery[] = [];
    const visit = (node: Node) => {
      if (node.type === "call_expression") {
        const callee = node.childForFieldName("function");
        const op = callee?.childForFieldName("property")?.text;
        const first = node.childForFieldName("arguments")?.namedChildren[0];
        if (op && RELATIONAL_OPS.includes(op)) {
          const tableMember = callee?.childForFieldName("object");
          const table = tableMember?.childForFieldName("property")?.text;
          if (table && member(member(tableMember, table), "query")?.text === "db") {
            out.push({ table, index: node.startIndex });
          }
        } else if (op === "from" && first?.type === "identifier") {
          const select = callee?.childForFieldName("object");
          const selectMember = select?.childForFieldName("function");
          const selectOp = selectMember?.childForFieldName("property")?.text;
          if (select?.type === "call_expression" && (selectOp === "select" || selectOp === "selectDistinct") &&
              member(selectMember, selectOp)?.text === "db") {
            out.push({ table: first.text, index: select.startIndex });
          }
        } else if (["insert", "update", "delete"].includes(op ?? "") && first?.type === "identifier" &&
                   member(callee, op!)?.text === "db") {
          out.push({ table: first.text, index: node.startIndex });
        }
      }
      for (const child of node.namedChildren) if (child) visit(child);
    };
    visit(root);
    return out.sort((a, b) => a.index - b.index);
  });
}

export function parseDrizzleQueries(content: string): DrizzleQuery[] {
  return drizzleQueries(content, "typescript");
}

function hasDrizzleMarker(content: string): boolean {
  if (
    content.includes("drizzle-orm") ||
    TABLE_FNS.some((f) => new RegExp(`\\b${f}\\s*\\(`).test(content)) ||
    /db\s*\.\s*query\s*\./.test(content)
  ) {
    return true;
  }
  // Bentuk builder tanpa import terlihat (`db.select().from(x)`):
  // aman diperiksa karena edge tetap butuh simbol model yang cocok.
  return /db\s*\.\s*(select|selectDistinct|insert|update|delete)\b/.test(content);
}

/** Turunkan edge QUERIES Drizzle untuk satu file (tanpa menulis DB). */
function drizzleQueryEdges(
  db: AdapterContext["db"],
  fileId: number,
  content: string,
  grammar: string
): QueryEdge[] {
  const out: QueryEdge[] = [];
  const fileSym = fileSymbolOf(db, fileId);
  if (!fileSym) return out;
  for (const q of drizzleQueries(content, grammar)) {
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

export function deriveDrizzleQueries(
  db: AdapterContext["db"],
  fileId: number,
  content: string
): QueryEdge[] {
  return drizzleQueryEdges(db, fileId, content, "typescript");
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
    for (const e of drizzleQueryEdges(db, f.fileId, f.content, grammarForPath(f.rel) ?? "typescript")) {
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
      for (const t of drizzleTables(f.content, grammarForPath(f.rel) ?? "typescript")) {
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
