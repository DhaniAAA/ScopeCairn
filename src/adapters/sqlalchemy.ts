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

// Adapter SQLAlchemy: `class X(Base):` (dengan `__tablename__`) menjadi
// simbol `model`; `session.query(X)` / `select(X)` menjadi edge QUERIES.
// Batasan: query dinamis (`getattr`, nama variabel) dilewati.

export interface SqlAlchemyModel {
  name: string;
  table: string | null;
  line: number;
}

export function parseSqlAlchemyModels(content: string): SqlAlchemyModel[] {
  const out: SqlAlchemyModel[] = [];
  const re = /^class\s+(\w+)\s*\(([^)]*)\)\s*:/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    const rest = content.slice(m.index, m.index + 1500);
    const nextClass = rest.slice(1).search(/^class\s+\w+/m);
    const body = nextClass > 0 ? rest.slice(0, nextClass + 1) : rest;
    const tm = /__tablename__\s*=\s*["']([^"']+)["']/.exec(body);
    const isBase = /\b(Base|DeclarativeBase|declarative_base|Model)\b/.test(m[2]);
    if (tm || isBase) {
      out.push({
        name: m[1],
        table: tm ? tm[1] : null,
        line: lineOf(content, m.index),
      });
    }
  }
  return out;
}

export interface SqlAlchemyQuery {
  model: string;
  index: number;
}

export function parseSqlAlchemyQueries(content: string): SqlAlchemyQuery[] {
  const out: SqlAlchemyQuery[] = [];
  const re = /(?:session\s*\.\s*query|select)\s*\(\s*(\w+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    out.push({ model: m[1], index: m.index });
  }
  return out;
}

function hasSqlAlchemyMarker(content: string): boolean {
  return (
    content.includes("sqlalchemy") ||
    /__tablename__/.test(content) ||
    /session\s*\.\s*query\s*\(/.test(content) ||
    /\bselect\s*\(/.test(content)
  );
}

function findModelGlobal(db: AdapterContext["db"], name: string): number | null {
  const rows = db
    .prepare(`SELECT id, name FROM symbols WHERE type = 'model'`)
    .all() as { id: number; name: string }[];
  const lower = name.toLowerCase();
  return rows.find((r) => r.name.toLowerCase() === lower)?.id ?? null;
}

/** Turunkan edge QUERIES SQLAlchemy untuk satu file (tanpa menulis DB). */
export function deriveSqlAlchemyQueries(
  db: AdapterContext["db"],
  fileId: number,
  content: string
): QueryEdge[] {
  const out: QueryEdge[] = [];
  const fileSym = fileSymbolOf(db, fileId);
  if (!fileSym) return out;
  for (const q of parseSqlAlchemyQueries(content)) {
    const target = findModelGlobal(db, q.model);
    if (!target) continue;
    const caller =
      enclosingFunction(db, fileId, lineOf(content, q.index)) ?? fileSym;
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

/** Hapus + turunkan ulang edge QUERIES untuk file-file ini (murah: regex). */
export function refreshSqlAlchemyQueries(
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
    if (!hasSqlAlchemyMarker(f.content)) continue;
    del.run(f.fileId);
    for (const e of deriveSqlAlchemyQueries(db, f.fileId, f.content)) {
      ins.run(e.callerId, e.targetId, e.weight, e.confidence);
      n++;
    }
  }
  return n;
}

export const sqlalchemyAdapter: FrameworkAdapter = {
  id: "sqlalchemy",
  label: "SQLAlchemy",
  detect: (files) =>
    files.some(
      (f) =>
        /\.py$/.test(f) ||
        /(^|\/)requirements.*\.txt$/.test(f) ||
        /(^|\/)pyproject\.toml$/.test(f)
    ),
  confirm: (repoRoot) => {
    let deps = "";
    try {
      const dir = fs.readdirSync(repoRoot);
      for (const f of dir) {
        if (/^requirements.*\.txt$/.test(f) || f === "pyproject.toml") {
          try {
            deps += fs.readFileSync(path.join(repoRoot, f), "utf8");
          } catch {
            // skip
          }
        }
      }
    } catch {
      return false;
    }
    return deps.toLowerCase().includes("sqlalchemy");
  },
  relevant: (rel) => /\.py$/.test(rel),
  apply(ctx: AdapterContext, files: AdapterFile[]): AdapterResult {
    let symbols = 0;
    let relations = 0;
    for (const f of files) {
      if (!hasSqlAlchemyMarker(f.content)) continue;
      const fileSym = fileSymbolOf(ctx.db, f.fileId);
      if (!fileSym) continue;
      for (const model of parseSqlAlchemyModels(f.content)) {
        const id = ensureAdapterSymbol(ctx.db, f.fileId, {
          name: model.name,
          type: "model",
          signature: model.table
            ? `model ${model.name} ("${model.table}")`
            : `model ${model.name}`,
          startLine: model.line,
          endLine: model.line,
        });
        symbols++;
        insertRelation(ctx.db, fileSym, id, "CONTAINS", 1.0, 1.0);
        relations++;
      }
    }
    // QUERIES anti-basi: turunkan ulang untuk file yang disentuh.
    relations += refreshSqlAlchemyQueries(
      ctx.db,
      files.map((f) => ({ fileId: f.fileId, rel: f.rel, content: f.content }))
    );
    return { symbols, relations };
  },
};
