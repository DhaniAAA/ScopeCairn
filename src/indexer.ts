import type { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { extractFile, testTarget } from "./extract/index.js";
import { syncFileIndex } from "./retrieval/symbolIndex.js";
import { evidenceOf, type RelationType, type ExtractedImport } from "./extract/types.js";
import {
  loadTsConfigForFile,
  resolveTsPathCandidates,
  resolveWorkspaceImportCandidates,
  type TsConfigPaths,
  type WorkspacePackage,
} from "./workspace.js";

export interface ModuleResolverContext {
  repoRoot: string;
  workspaces: WorkspacePackage[];
  tsConfigCache: Map<string, TsConfigPaths | null>;
}

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

// Resolusi nama global: prefer simbol di direktori yang sama dengan file
// sumber, lalu top-level dir yang sama; fallback id terkecil (deterministik).
function globalSymbolId(
  db: DatabaseSync,
  name: string,
  preferDir = ""
): number | null {
  const rows = db
    .prepare(
      `SELECT s.id, f.path AS p FROM symbols s JOIN files f ON f.id = s.file_id
       WHERE s.name = ? ORDER BY s.id`
    )
    .all(name) as { id: number; p: string }[];
  if (rows.length === 0) return null;
  if (preferDir) {
    const sameDir = rows.find((r) => r.p.startsWith(preferDir + "/"));
    if (sameDir) return sameDir.id;
    const top = preferDir.split("/")[0];
    const sameTop = rows.find((r) => r.p.split("/")[0] === top);
    if (sameTop) return sameTop.id;
  }
  return rows[0].id;
}

// Resolusi method call (`obj.name(`): hanya ke simbol method/component.
// Helper lokal bertipe function (mis. `const push = (`) TIDAK boleh
// menampung semua `x.push(` sedunia — itu meracuni fan-in.
function methodSymbolId(
  db: DatabaseSync,
  _fileId: number,
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

interface ResolvedModule {
  fileId: number;
  fileSymId: number;
}

function expandModuleCandidates(base: string): string[] {
  const norm = base.replace(/\\/g, "/").replace(/^\.\//, "");
  const out = [norm];
  const jsExt = norm.match(/\.(js|mjs|cjs|jsx)$/);
  if (jsExt) {
    const stripped = norm.slice(0, -jsExt[0].length);
    out.push(stripped, stripped + ".ts", stripped + ".tsx");
  }
  out.push(
    norm + ".ts",
    norm + ".tsx",
    norm + ".js",
    norm + ".jsx",
    norm + ".py",
    norm + "/index.ts",
    norm + "/index.tsx",
    norm + "/index.js"
  );
  return out;
}

function lookupFileSymbol(db: DatabaseSync, relPath: string): ResolvedModule | null {
  const r = db.prepare(`SELECT id FROM files WHERE path = ?`).get(relPath) as
    | { id: number }
    | undefined;
  if (!r) return null;
  const s = db
    .prepare(`SELECT id FROM symbols WHERE file_id = ? AND type = 'file'`)
    .get(r.id) as { id: number } | undefined;
  return s ? { fileId: r.id, fileSymId: s.id } : null;
}

function resolveModuleFile(
  db: DatabaseSync,
  fromRel: string,
  spec: string,
  ctx?: ModuleResolverContext
): ResolvedModule | null {
  const dir = fromRel.includes("/") ? fromRel.slice(0, fromRel.lastIndexOf("/")) : "";

  // 1. tsconfig.json `paths` & `baseUrl` serta workspace package imports
  if (ctx && !spec.startsWith(".")) {
    const customBases: string[] = [];
    const tsCfg = loadTsConfigForFile(ctx.repoRoot, fromRel, ctx.tsConfigCache);
    if (tsCfg) {
      customBases.push(...resolveTsPathCandidates(tsCfg, spec));
    }
    if (ctx.workspaces.length > 0) {
      customBases.push(...resolveWorkspaceImportCandidates(ctx.workspaces, spec));
    }
    for (const base of customBases) {
      for (const c of expandModuleCandidates(base)) {
        if (c === fromRel) continue;
        const found = lookupFileSymbol(db, c);
        if (found) return found;
      }
    }
  }

  let normalizedSpec = spec;
  if (spec.startsWith("@/") || spec.startsWith("~/")) {
    normalizedSpec = spec.replace(/^[@~]\//, "src/");
  }

  const joined = normalizedSpec.startsWith(".")
    ? path.posix.normalize((dir ? dir + "/" : "") + normalizedSpec)
    : normalizedSpec;

  const candidates = expandModuleCandidates(joined);
  if (normalizedSpec !== spec) {
    candidates.push(...expandModuleCandidates(spec.replace(/^[@~]\//, "")));
  }
  for (const c of candidates) {
    if (c === fromRel) continue;
    const found = lookupFileSymbol(db, c);
    if (found) return found;
  }

  // Non-relative import fallback (mis. Python module atau Go package)
  if (!spec.startsWith(".")) {
    const lastPart = spec.split("/").pop() ?? spec;
    const match = db
      .prepare(
        `SELECT id, path FROM files WHERE (path = ? OR path LIKE ? OR path LIKE ?) AND path != ? LIMIT 1`
      )
      .get(spec, `%/${lastPart}.%`, `%/${lastPart}/index.%`, fromRel) as { id: number; path: string } | undefined;
    if (match) {
      const s = db
        .prepare(`SELECT id FROM symbols WHERE file_id = ? AND type = 'file'`)
        .get(match.id) as { id: number } | undefined;
      if (s) return { fileId: match.id, fileSymId: s.id };
    }
  }

  return null;
}

function resolveModuleToFile(
  db: DatabaseSync,
  fromRel: string,
  spec: string,
  ctx?: ModuleResolverContext
): number | null {
  const res = resolveModuleFile(db, fromRel, spec, ctx);
  return res ? res.fileSymId : null;
}

/**
 * Cari simbol di file target atau melalui rantai barrel re-export (`EXPORTS`) hingga 3 hop.
 */
function resolveSymbolInModuleOrBarrel(
  db: DatabaseSync,
  startFileId: number,
  symName: string,
  allowedTypes?: string[]
): number | null {
  const typeClause =
    allowedTypes && allowedTypes.length > 0
      ? `type IN (${allowedTypes.map((t) => `'${t}'`).join(",")})`
      : `type != 'file'`;
  const direct = db
    .prepare(`SELECT id FROM symbols WHERE file_id = ? AND name = ? AND ${typeClause} LIMIT 1`)
    .get(startFileId, symName) as { id: number } | undefined;
  if (direct) return direct.id;

  const visitedFiles = new Set<number>([startFileId]);
  let frontier = [startFileId];
  for (let hop = 0; hop < 3 && frontier.length > 0; hop++) {
    const nextFrontier: number[] = [];
    for (const fid of frontier) {
      const reExports = db
        .prepare(
          `SELECT reExportedSym.file_id AS nextFileId
           FROM symbols barrelSym
           JOIN relationships rel ON rel.source_id = barrelSym.id AND rel.relationship_type = 'EXPORTS'
           JOIN symbols reExportedSym ON reExportedSym.id = rel.target_id
           WHERE barrelSym.file_id = ? AND barrelSym.type = 'file'`
        )
        .all(fid) as { nextFileId: number }[];
      for (const row of reExports) {
        if (visitedFiles.has(row.nextFileId)) continue;
        visitedFiles.add(row.nextFileId);
        const found = db
          .prepare(`SELECT id FROM symbols WHERE file_id = ? AND name = ? AND ${typeClause} LIMIT 1`)
          .get(row.nextFileId, symName) as { id: number } | undefined;
        if (found) return found.id;
        nextFrontier.push(row.nextFileId);
      }
    }
    frontier = nextFrontier;
  }
  return null;
}

// Re-index one file: re-insert its symbols, then relations (phase 2).
// Two-phase: phase 1 inserts symbols for ALL changed files first, so that
// phase 2 cross-file resolution (CALLS, IMPORTS) is order-independent.
//
// PENTING — ID simbol harus STABIL. Riwayat sebelumnya melakukan
// `DELETE FROM symbols WHERE file_id = ?` lalu INSERT. Karena
// relationships.source_id/target_id = ON DELETE CASCADE (db.ts) dan
// foreign_keys = ON, cascade itu ikut menghapus edge yang SUMBERNYA di file
// LAIN yang tidak berubah — mis. `IMPORTS` dari para pengimpor. File lain
// tidak masuk daftar `pending`, jadi edge-nya tidak pernah dibangun ulang:
// setiap edit satu file mellowsi fan-in secara permanen dan monoton.
//
// Di sini simbol yang masih ada di-update pada baris yang sama (ID bertahan),
// dan hanya simbol yang benar-benar hilang yang di-DELETE — sehingga edge
// inbound tetap utuh, dan edge ke simbol yang hilang hilang dengan tepat.
export function indexFileSymbols(
  db: DatabaseSync,
  fileId: number,
  relPath: string,
  content: string
): { extraction: ReturnType<typeof extractFile>; fileSym: number } {
  const ext = extractFile(relPath, content);
  const fileSym = fileSymbolId(db, fileId, relPath);

  // Kandidat reuse dikunci (type, name), dipisah \u0000 karena nama simbol
  // tidak mungkin mengandung NUL — jadi key tidak pernah bertabrakan.
  // Diurutkan id agar overload/nama kembar consumption-nya deterministik.
  const existingRows = db
    .prepare(
      `SELECT id, name, type FROM symbols
       WHERE file_id = ? AND type != 'file' ORDER BY id`
    )
    .all(fileId) as { id: number; name: string; type: string }[];
  const byKey = new Map<string, number[]>();
  for (const r of existingRows) {
    const key = `${r.type}\u0000${r.name}`;
    const bucket = byKey.get(key);
    if (bucket) bucket.push(r.id);
    else byKey.set(key, [r.id]);
  }

  const insSym = db.prepare(
    `INSERT INTO symbols(file_id, name, type, signature, start_line, end_line, doc)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  const updSym = db.prepare(
    `UPDATE symbols SET signature = ?, start_line = ?, end_line = ?, doc = ? WHERE id = ?`
  );
  const kept = new Set<number>();
  for (const s of ext.symbols) {
    if (s.type === "import" || s.type === "export") continue;
    const bucket = byKey.get(`${s.type}\u0000${s.name}`);
    const reuseId = bucket && bucket.length > 0 ? bucket.shift() : undefined;
    if (reuseId !== undefined) {
      kept.add(reuseId);
      updSym.run(s.signature, s.startLine, s.endLine, s.doc ?? "", reuseId);
    } else {
      const r = insSym.run(fileId, s.name, s.type, s.signature, s.startLine, s.endLine, s.doc ?? "");
      kept.add(Number(r.lastInsertRowid));
    }
  }

  // Hanya simbol yang benar-benar tidak ada lagi. Cascade dari sini CORRECT:
  // tidak ada lagi simbol yang jadi target edge tersebut.
  const stale = existingRows.filter((r) => !kept.has(r.id)).map((r) => r.id);
  if (stale.length > 0) {
    const delSym = db.prepare(`DELETE FROM symbols WHERE id = ?`);
    for (const id of stale) delSym.run(id);
  }

  syncFileIndex(db, fileId, relPath);
  return { extraction: ext, fileSym };
}

export function seedExportRelations(
  db: DatabaseSync,
  fileId: number,
  relPath: string,
  extraction: ReturnType<typeof extractFile>,
  fileSym: number,
  ctx?: ModuleResolverContext
): void {
  const srcDir = relPath.includes("/") ? relPath.slice(0, relPath.lastIndexOf("/")) : "";
  const insRel = db.prepare(
    `INSERT INTO relationships(source_id, target_id, relationship_type, weight, confidence, evidence)
     VALUES (?, ?, 'EXPORTS', ?, ?, ?)`
  );
  db.prepare(
    `DELETE FROM relationships WHERE source_id = ? AND relationship_type = 'EXPORTS'`
  ).run(fileSym);
  for (const r of extraction.relations) {
    if (r.rel !== "EXPORTS") continue;
    if (r.to.startsWith("export*:")) {
      const target = resolveModuleToFile(db, relPath, r.to.slice(8), ctx);
      if (target) {
        insRel.run(fileSym, target, r.weight, r.confidence, evidenceOf("EXPORTS", r.confidence));
      }
      continue;
    }
    const target =
      symbolIdInFile(db, fileId, r.to) ?? globalSymbolId(db, r.to, srcDir);
    if (target && target !== fileSym) {
      insRel.run(fileSym, target, r.weight, r.confidence, evidenceOf("EXPORTS", r.confidence));
    }
  }
}

export function indexFileRelations(
  db: DatabaseSync,
  fileId: number,
  relPath: string,
  extraction: ReturnType<typeof extractFile>,
  fileSym: number,
  ctx?: ModuleResolverContext
): IndexResult {
  // Bersihkan edge OUTBOUND file ini dulu. Sebelumnya phase 1 melakukan
  // `DELETE FROM symbols WHERE file_id = ?` dan cascade ikut menghapus edge
  // ini — jadi penghapusan itu terjadi "dengan papan bawah" saat simbol
  // ber-hapus. Sekarang simbol yang bertahan dipertahankan (ID stabil),
  // cascade tidak lagi menyapu, sehingga tanpa penghapusan eksplisit tiap
  // re-index akan menumpuk edge duplikat (CALLS yang sama hingga puluhan kali).
  //
  // PENTING: hanya source_id milik file ini. Edge yang MASUK ke file ini
  // (source di file lain) tidak boleh disentuh — justru itu yang membuat
  // fan-in hilang di bug lama.
  db.prepare(
    `DELETE FROM relationships
      WHERE source_id IN (SELECT id FROM symbols WHERE file_id = ?)`
  ).run(fileId);

  const ids = new Map<string, number>();
  const rows = db
    .prepare(`SELECT id, name FROM symbols WHERE file_id = ? AND type != 'file'`)
    .all(fileId) as { id: number; name: string }[];
  for (const r of rows) if (!ids.has(r.name)) ids.set(r.name, r.id);

  const localImports = new Map<string, ExtractedImport>();
  for (const imp of extraction.imports ?? []) {
    localImports.set(imp.localName, imp);
  }

  const insRel = db.prepare(
    `INSERT INTO relationships(source_id, target_id, relationship_type, weight, confidence, evidence)
     VALUES (?, ?, ?, ?, ?, ?)`
  );
  const contains = db.prepare(
    `INSERT INTO relationships(source_id, target_id, relationship_type, weight, confidence, evidence)
     VALUES (?, ?, 'CONTAINS', 1.0, 1.0, 'EXTRACTED')`
  );
  let rels = 0;
  for (const id of ids.values()) {
    contains.run(fileSym, id);
    rels++;
  }

  const srcDir = relPath.includes("/")
    ? relPath.slice(0, relPath.lastIndexOf("/"))
    : "";
  const resolveLocal = (name: string): number | null => {
    if (name === "__file__") return fileSym;
    return (
      ids.get(name) ?? symbolIdInFile(db, fileId, name) ?? globalSymbolId(db, name, srcDir)
    );
  };

  const importedFileIds = new Set<number>();

  for (const r of extraction.relations) {
    if (r.rel === "IMPORTS") {
      const target = resolveModuleFile(db, relPath, r.to, ctx);
      if (target && target.fileSymId !== fileSym) {
        importedFileIds.add(target.fileId);
        insRel.run(fileSym, target.fileSymId, "IMPORTS", r.weight, r.confidence, evidenceOf("IMPORTS", r.confidence));
        rels++;
      }
      continue;
    }
    if (r.rel === "EXPORTS") {
      if (r.to.startsWith("export*:")) {
        const target = resolveModuleToFile(db, relPath, r.to.slice(8), ctx);
        if (target) {
          insRel.run(fileSym, target, "EXPORTS", r.weight, r.confidence, evidenceOf("EXPORTS", r.confidence));
          rels++;
        }
        continue;
      }
      const target = resolveLocal(r.to);
      if (target && target !== fileSym) {
        insRel.run(fileSym, target, "EXPORTS", r.weight, r.confidence, evidenceOf("EXPORTS", r.confidence));
        rels++;
      }
      continue;
    }
    if (r.rel === "PARAM_TYPE" || r.rel === "RETURN_TYPE" || r.rel === "TYPED_AS" || r.rel === "IMPLEMENTS") {
      const src = resolveLocal(r.from);
      if (!src) continue;

      let dst: number | null = null;
      if (localImports.has(r.to)) {
        const imp = localImports.get(r.to)!;
        const targetMod = resolveModuleFile(db, relPath, imp.moduleSpecifier, ctx);
        if (targetMod) {
          const symName = imp.importedName === "default" || imp.importedName === "*" ? r.to : imp.importedName;
          dst = resolveSymbolInModuleOrBarrel(db, targetMod.fileId, symName, [
            "interface",
            "type",
            "class",
            "model",
          ]);
        }
      }
      if (!dst) {
        const local = ids.get(r.to) ?? symbolIdInFile(db, fileId, r.to);
        if (local) dst = local;
      }
      if (!dst && importedFileIds.size > 0) {
        const ph = [...importedFileIds].map(() => "?").join(",");
        const sym = db
          .prepare(`SELECT id FROM symbols WHERE file_id IN (${ph}) AND name = ? AND type IN ('interface', 'type', 'class', 'model') LIMIT 1`)
          .get(...importedFileIds, r.to) as { id: number } | undefined;
        if (sym) dst = sym.id;
      }
      if (!dst) {
        dst = globalSymbolId(db, r.to, srcDir);
      }
      if (dst && src !== dst) {
        insRel.run(src, dst, r.rel, r.weight, r.confidence, evidenceOf(r.rel, r.confidence));
        rels++;
      }
      continue;
    }

    if (r.rel === "CALLS") {
      const src = resolveLocal(r.from);
      if (!src) continue;

      let dst: number | null = null;
      let conf = r.confidence;
      let ev = evidenceOf("CALLS", conf, r.methodCall);

      // Semantic Typed Resolution: cek receiverType terlebih dahulu bila ada
      if (r.receiverType) {
        let typeFileId: number | null = null;
        let typeSymId: number | null = null;

        if (localImports.has(r.receiverType)) {
          const imp = localImports.get(r.receiverType)!;
          const targetMod = resolveModuleFile(db, relPath, imp.moduleSpecifier, ctx);
          if (targetMod) {
            typeFileId = targetMod.fileId;
            const symName = imp.importedName === "default" || imp.importedName === "*" ? r.receiverType : imp.importedName;
            const symId = resolveSymbolInModuleOrBarrel(db, targetMod.fileId, symName);
            if (symId) typeSymId = symId;
          }
        }
        if (!typeFileId) {
          const local = ids.get(r.receiverType) ?? symbolIdInFile(db, fileId, r.receiverType);
          if (local) {
            typeSymId = local;
            typeFileId = fileId;
          }
        }
        if (!typeFileId && importedFileIds.size > 0) {
          const ph = [...importedFileIds].map(() => "?").join(",");
          const sym = db
            .prepare(`SELECT id, file_id FROM symbols WHERE file_id IN (${ph}) AND name = ? AND type IN ('class', 'interface', 'model', 'type') LIMIT 1`)
            .get(...importedFileIds, r.receiverType) as { id: number; file_id: number } | undefined;
          if (sym) {
            typeSymId = sym.id;
            typeFileId = sym.file_id;
          }
        }
        if (!typeFileId) {
          const gSym = db
            .prepare(`SELECT s.id, s.file_id FROM symbols s JOIN files f ON f.id = s.file_id WHERE s.name = ? AND s.type IN ('class', 'interface', 'model', 'type') LIMIT 1`)
            .get(r.receiverType) as { id: number; file_id: number } | undefined;
          if (gSym) {
            typeSymId = gSym.id;
            typeFileId = gSym.file_id;
          }
        }

        if (typeFileId) {
          const sym = db
            .prepare(`SELECT id FROM symbols WHERE file_id = ? AND name = ? AND type IN ('method', 'function') LIMIT 1`)
            .get(typeFileId, r.to) as { id: number } | undefined;
          if (sym) {
            dst = sym.id;
            conf = 0.95;
            ev = "EXTRACTED";
          } else if (typeSymId) {
            // Polymorphic dispatch / inherited method lookup via EXTENDS / IMPLEMENTS
            const parentRows = db
              .prepare(`SELECT target_id FROM relationships WHERE source_id = ? AND relationship_type IN ('EXTENDS', 'IMPLEMENTS')`)
              .all(typeSymId) as { target_id: number }[];
            for (const p of parentRows) {
              const parentSym = db
                .prepare(`SELECT s.id, s.file_id FROM symbols s WHERE s.id = ?`)
                .get(p.target_id) as { id: number; file_id: number } | undefined;
              if (parentSym) {
                const mSym = db
                  .prepare(`SELECT id FROM symbols WHERE file_id = ? AND name = ? AND type IN ('method', 'function') LIMIT 1`)
                  .get(parentSym.file_id, r.to) as { id: number } | undefined;
                if (mSym) {
                  dst = mSym.id;
                  conf = 0.9;
                  ev = "EXTRACTED";
                  break;
                }
              }
            }
          }
        }
      }

      // Receiver-based call: e.g. u.format() or pkg.Func() or this.method()
      if (!dst && r.receiver) {
        if (r.receiver === "this" || r.receiver === "self") {
          dst = ids.get(r.to) ?? symbolIdInFile(db, fileId, r.to);
          if (dst) {
            conf = 1.0;
            ev = "EXTRACTED";
          }
        } else if (localImports.has(r.receiver)) {
          const imp = localImports.get(r.receiver)!;
          const targetMod = resolveModuleFile(db, relPath, imp.moduleSpecifier, ctx);
          if (targetMod) {
            const symId = resolveSymbolInModuleOrBarrel(db, targetMod.fileId, r.to);
            if (symId) {
              dst = symId;
              conf = 0.95;
              ev = "EXTRACTED";
            }
          }
        }
      }

      // Direct call or receiver not found in localImports
      if (!dst) {
        // Level 1: Same file local symbol
        const local = ids.get(r.to) ?? symbolIdInFile(db, fileId, r.to);
        if (local) {
          dst = local;
          conf = 1.0;
          ev = "EXTRACTED";
        }
      }

      // Level 2: Named import match
      if (!dst && localImports.has(r.to)) {
        const imp = localImports.get(r.to)!;
        const targetMod = resolveModuleFile(db, relPath, imp.moduleSpecifier, ctx);
        if (targetMod) {
          const symName = imp.importedName === "default" || imp.importedName === "*" ? r.to : imp.importedName;
          const symId = resolveSymbolInModuleOrBarrel(db, targetMod.fileId, symName);
          if (symId) {
            dst = symId;
            conf = 0.95;
            ev = "EXTRACTED";
          }
        }
      }

      // Level 3: Wildcard / imported files check
      if (!dst && importedFileIds.size > 0) {
        const ph = [...importedFileIds].map(() => "?").join(",");
        const sym = db
          .prepare(`SELECT id FROM symbols WHERE file_id IN (${ph}) AND name = ? AND type != 'file' LIMIT 1`)
          .get(...importedFileIds, r.to) as { id: number } | undefined;
        if (sym) {
          dst = sym.id;
          conf = 0.7;
          ev = "INFERRED";
        }
      }

      // Level 4: Global heuristic fallback
      if (!dst) {
        dst = r.methodCall
          ? methodSymbolId(db, fileId, ids, r.to)
          : globalSymbolId(db, r.to, srcDir);
        if (dst) {
          conf = 0.3;
          ev = "AMBIGUOUS";
        }
      }

      if (dst && src !== dst) {
        insRel.run(src, dst, "CALLS", r.weight, conf, ev);
        rels++;
      }
      continue;
    }

    const src = resolveLocal(r.from);
    if (!src) continue;
    let dst: number | null = ids.get(r.to) ?? symbolIdInFile(db, fileId, r.to);
    let conf = r.confidence;
    if (!dst && localImports.has(r.to)) {
      const imp = localImports.get(r.to)!;
      const targetMod = resolveModuleFile(db, relPath, imp.moduleSpecifier, ctx);
      if (targetMod) {
        const symName = imp.importedName === "default" || imp.importedName === "*" ? r.to : imp.importedName;
        const symId = resolveSymbolInModuleOrBarrel(db, targetMod.fileId, symName);
        if (symId) {
          dst = symId;
          conf = 0.95;
        }
      }
    }
    if (!dst && importedFileIds.size > 0) {
      const ph = [...importedFileIds].map(() => "?").join(",");
      const sym = db
        .prepare(`SELECT id FROM symbols WHERE file_id IN (${ph}) AND name = ? AND type != 'file' LIMIT 1`)
        .get(...importedFileIds, r.to) as { id: number } | undefined;
      if (sym) {
        dst = sym.id;
        conf = 0.7;
      }
    }
    if (!dst && r.rel !== "REFERENCES") {
      dst = globalSymbolId(db, r.to, srcDir);
    }
    if (src && dst && src !== dst) {
      insRel.run(src, dst, r.rel, r.weight, conf, evidenceOf(r.rel as RelationType, conf, r.methodCall));
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
    `INSERT INTO relationships(source_id, target_id, relationship_type, weight, confidence, evidence)
     VALUES (?, ?, 'TESTS', 0.9, 0.8, 'INFERRED')`
  );
  for (const f of files) {
    const stemBase = testTarget(f.path);
    if (!stemBase) continue;
    // Cocokkan stem basename: tests/cycles.test.ts → cycles di src/... mana pun.
    const stemName = stemBase.split("/").pop()!;
    const matches = [...byPath.keys()].filter((p) => {
      if (p === f.path || testTarget(p)) return false;
      const base = p.split("/").pop() ?? p;
      return base.replace(/\.[^.]+$/, "") === stemName;
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
