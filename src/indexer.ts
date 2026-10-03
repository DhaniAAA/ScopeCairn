import type { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { extractFile, testTarget } from "./extract/index.js";
import { syncFileIndex } from "./retrieval/symbolIndex.js";

export interface IndexResult {
  symbols: number;
  relations: number;
}

function fileSymbolId(
  db: DatabaseSync,
  fileId: number,
  relPath: string
): number {
  const existing = db
    .prepare(`SELECT id FROM symbols WHERE file_id = ? AND type = 'file'`)
    .get(fileId) as { id: number } | undefined;
  if (existing) return existing.id;
  const r = db
    .prepare(
      `INSERT INTO symbols(file_id, name, type, signature, start_line, end_line)
       VALUES (?, ?, 'file', '', 1, 1)`
    )
    .run(fileId, relPath);
  return Number(r.lastInsertRowid);
}

function symbolIdInFile(
  db: DatabaseSync,
  fileId: number,
  name: string
): number | null {
  const r = db
    .prepare(`SELECT id FROM symbols WHERE file_id = ? AND name = ? LIMIT 1`)
    .get(fileId, name) as { id: number } | undefined;
  return r ? r.id : null;
}

function globalSymbolId(db: DatabaseSync, name: string): number | null {
  const r = db
    .prepare(`SELECT id FROM symbols WHERE name = ? LIMIT 1`)
    .get(name) as { id: number } | undefined;
  return r ? r.id : null;
}

// Resolusi method call (`obj.name(`): hanya ke simbol method/component.
// Helper lokal bertipe function (mis. `const push = (`) TIDAK boleh
// menampung semua `x.push(` sedunia — itu meracuni fan-in.
function methodSymbolId(
  db: DatabaseSync,
  fileId: number,
  ids: Map<string, number>,
  name: string
): number | null {
  const local = ids.get(name);
  if (local) {
    const t = db.prepare(`SELECT type FROM symbols WHERE id = ?`).get(local) as
      | { type: string }
      | undefined;
    if (t && ["method", "component"].includes(t.type)) return local;
  }
  const r = db
    .prepare(
      `SELECT id FROM symbols WHERE name = ? AND type IN ('method','component') LIMIT 1`
    )
    .get(name) as { id: number } | undefined;
  return r ? r.id : null;
}

function resolveModuleToFile(
  db: DatabaseSync,
  fromRel: string,
  spec: string
): number | null {
  if (!spec.startsWith(".")) return null; // external package — skip
  const dir = fromRel.includes("/") ? fromRel.slice(0, fromRel.lastIndexOf("/")) : "";
  const joined = path.posix.normalize((dir ? dir + "/" : "") + spec);
  // TS ESM imports reference compiled ".js" for a ".ts" source — strip it.
  const bases = [joined];
  const jsExt = joined.match(/\.(js|mjs|cjs|jsx)$/);
  if (jsExt) {
    const stripped = joined.slice(0, -(jsExt[0].length));
    bases.push(stripped, stripped + ".ts", stripped + ".tsx");
  }
  const candidates = [
    ...bases,
    joined + ".ts",
    joined + ".tsx",
    joined + ".js",
    joined + ".jsx",
    joined + ".py",
    joined + "/index.ts",
    joined + "/index.js",
  ];
  for (const c of candidates) {
    const r = db
      .prepare(`SELECT id FROM files WHERE path = ?`)
      .get(c) as { id: number } | undefined;
    if (r) {
      const s = db
        .prepare(`SELECT id FROM symbols WHERE file_id = ? AND type = 'file'`)
        .get(r.id) as { id: number } | undefined;
      if (s) return s.id;
    }
  }
  return null;
}

// Re-index one file: wipe its symbols (relations cascade), re-insert.
// Two-phase: phase 1 inserts symbols for ALL changed files first, so that
// phase 2 cross-file resolution (CALLS, IMPORTS) is order-independent.
export function indexFileSymbols(
  db: DatabaseSync,
  fileId: number,
  relPath: string,
  content: string
): { extraction: ReturnType<typeof extractFile>; fileSym: number } {
  db.prepare(`DELETE FROM symbols WHERE file_id = ?`).run(fileId);
  const fileSym = fileSymbolId(db, fileId, relPath);
  const ext = extractFile(relPath, content);

  const insSym = db.prepare(
    `INSERT INTO symbols(file_id, name, type, signature, start_line, end_line)
     VALUES (?, ?, ?, ?, ?, ?)`
  );
  for (const s of ext.symbols) {
    if (s.type === "import" || s.type === "export") continue;
    insSym.run(fileId, s.name, s.type, s.signature, s.startLine, s.endLine);
  }
  syncFileIndex(db, fileId, relPath);
  return { extraction: ext, fileSym };
}

export function indexFileRelations(
  db: DatabaseSync,
  fileId: number,
  relPath: string,
  extraction: ReturnType<typeof extractFile>,
  fileSym: number
): IndexResult {
  const ids = new Map<string, number>();
  const rows = db
    .prepare(`SELECT id, name FROM symbols WHERE file_id = ? AND type != 'file'`)
    .all(fileId) as { id: number; name: string }[];
  for (const r of rows) if (!ids.has(r.name)) ids.set(r.name, r.id);

  const insRel = db.prepare(
    `INSERT INTO relationships(source_id, target_id, relationship_type, weight, confidence)
     VALUES (?, ?, ?, ?, ?)`
  );
  const contains = db.prepare(
    `INSERT INTO relationships(source_id, target_id, relationship_type, weight, confidence)
     VALUES (?, ?, 'CONTAINS', 1.0, 1.0)`
  );
  let rels = 0;
  for (const id of ids.values()) {
    contains.run(fileSym, id);
    rels++;
  }

  const resolveLocal = (name: string): number | null => {
    if (name === "__file__") return fileSym;
    return ids.get(name) ?? symbolIdInFile(db, fileId, name) ?? globalSymbolId(db, name);
  };

  for (const r of extraction.relations) {
    if (r.rel === "IMPORTS") {
      const target = resolveModuleToFile(db, relPath, r.to);
      if (target) {
        insRel.run(fileSym, target, "IMPORTS", r.weight, r.confidence);
        rels++;
      }
      continue;
    }
    if (r.rel === "EXPORTS") {
      if (r.to.startsWith("export*:")) {
        const target = resolveModuleToFile(db, relPath, r.to.slice(8));
        if (target) {
          insRel.run(fileSym, target, "EXPORTS", r.weight, r.confidence);
          rels++;
        }
        continue;
      }
      const target = resolveLocal(r.to);
      if (target && target !== fileSym) {
        insRel.run(fileSym, target, "EXPORTS", r.weight, r.confidence);
        rels++;
      }
      continue;
    }
    const src = resolveLocal(r.from);
    const dst =
      r.rel === "CALLS" && r.methodCall
        ? methodSymbolId(db, fileId, ids, r.to)
        : (ids.get(r.to) ?? globalSymbolId(db, r.to));
    if (src && dst && src !== dst) {
      insRel.run(src, dst, r.rel, r.weight, r.confidence);
      rels++;
    }
  }

  return { symbols: ids.size, relations: rels };
}

// File non-source (config/skema/migrasi): simpul file saja, tanpa ekstraksi isi.
export function indexMetaFile(
  db: DatabaseSync,
  fileId: number,
  relPath: string
): void {
  db.prepare(`DELETE FROM symbols WHERE file_id = ?`).run(fileId);
  fileSymbolId(db, fileId, relPath);
  syncFileIndex(db, fileId, relPath);
}

// Back-compat single-file path (tests / one-offs). Order-dependent;
// scanner uses the two-phase functions above.
export function indexFile(
  db: DatabaseSync,
  fileId: number,
  relPath: string,
  content: string
): IndexResult {
  const { extraction, fileSym } = indexFileSymbols(db, fileId, relPath, content);
  return indexFileRelations(db, fileId, relPath, extraction, fileSym);
}

// TESTS edges after full scan (needs complete file list).
export function linkTests(db: DatabaseSync): number {
  const files = db.prepare(`SELECT id, path FROM files`).all() as {
    id: number;
    path: string;
  }[];
  const byPath = new Map(files.map((f) => [f.path, f.id]));
  const fileSymOf = (fid: number): number | null => {
    const r = db
      .prepare(`SELECT id FROM symbols WHERE file_id = ? AND type = 'file'`)
      .get(fid) as { id: number } | undefined;
    return r ? r.id : null;
  };
  db.prepare(`DELETE FROM relationships WHERE relationship_type = 'TESTS'`).run();
  let n = 0;
  const ins = db.prepare(
    `INSERT INTO relationships(source_id, target_id, relationship_type, weight, confidence)
     VALUES (?, ?, 'TESTS', 0.9, 0.8)`
  );
  for (const f of files) {
    const stemBase = testTarget(f.path);
    if (!stemBase) continue;
    // Match stem with any known extension, same dir first.
    const matches = [...byPath.keys()].filter((p) => {
      const noExt = p.replace(/\.[^.]+$/, "");
      return noExt === stemBase && p !== f.path;
    });
    const srcSym = fileSymOf(f.id);
    for (const mp of matches) {
      const dstSym = fileSymOf(byPath.get(mp)!);
      if (srcSym && dstSym) {
        ins.run(srcSym, dstSym);
        n++;
      }
    }
  }
  return n;
}
