import fs from "node:fs";
import path from "node:path";
import { detectLanguage, isSourceFile } from "./languages.js";
import { hashContent, openDb, dataDir } from "./db.js";
import { loadIgnoreRules, isIgnored } from "./ignore.js";
import { indexFileSymbols, indexFileRelations, indexMetaFile, linkTests } from "./indexer.js";
import { cleanupIndex } from "./retrieval/symbolIndex.js";
import { ensureDefaultFiles } from "./retrieval/config.js";
import { isIndexableMetaFile } from "./scope/protected.js";
import { runAdapters } from "./adapters/index.js";
import { writeGraphMdIfChanged } from "./graph/export.js";
import { buildVisualModel, renderHtml, GRAPH_HTML_NAME } from "./graph/visual.js";

export interface ScanStats {
  repoRoot: string;
  totalFilesSeen: number;
  sourceFiles: number;
  metaFiles: number;
  symbols: number;
  relationships: number;
  adapters: string[];
  graphWritten: boolean;
  visualWritten: boolean;
  inserted: number;
  updated: number;
  unchanged: number;
  removed: number;
  durationMs: number;
}

function toPosixRel(repoRoot: string, abs: string): string {
  return path.relative(repoRoot, abs).split(path.sep).join("/");
}

function walk(absDir: string, out: string[]): void {
  const entries = fs.readdirSync(absDir, { withFileTypes: true });
  for (const e of entries) {
    const abs = path.join(absDir, e.name);
    if (e.isDirectory()) {
      // Skip symlinked dirs to avoid loops.
      if (e.isSymbolicLink()) continue;
      walk(abs, out);
    } else if (e.isFile()) {
      out.push(abs);
    }
  }
}

export function scanRepository(repoRoot: string): ScanStats {
  const started = Date.now();
  const rules = loadIgnoreRules(repoRoot);
  const db = openDb(repoRoot);
  ensureDefaultFiles(repoRoot);
  try {
    const allAbs: string[] = [];
    walk(repoRoot, allAbs);

    let totalFilesSeen = 0;
    let inserted = 0;
    let updated = 0;
    let unchanged = 0;
    const seenPaths = new Set<string>();

    const getStmt = db.prepare(`SELECT id, hash FROM files WHERE path = ?`);
    const insertStmt = db.prepare(
      `INSERT INTO files(path, language, hash, size) VALUES (?, ?, ?, ?)`
    );
    const updateStmt = db.prepare(
      `UPDATE files SET hash = ?, size = ?, language = ?, updated_at = datetime('now') WHERE path = ?`
    );

    let sourceFiles = 0;
    let metaFiles = 0;

    // Backfill: DBs lama tanpa graph/FTS — re-extract semuanya sekali.
    const symbolCount = (
      db.prepare(`SELECT COUNT(*) AS n FROM symbols`).get() as { n: number }
    ).n;
    let ftsCount = 0;
    try {
      ftsCount = (db.prepare(`SELECT COUNT(*) AS n FROM symbol_index`).get() as { n: number }).n;
    } catch {
      ftsCount = 0;
    }
    const backfill = symbolCount === 0 || ftsCount === 0;

    // Two-phase indexing: phase 1 inserts symbols for all changed files,
    // phase 2 resolves relations — cross-file edges are order-independent.
    const pending: { fileId: number; rel: string; content: string }[] = [];
    const metaChanged: { fileId: number; rel: string }[] = [];

    for (const abs of allAbs) {
      const rel = toPosixRel(repoRoot, abs);
      if (isIgnored(rel, rules)) continue;
      totalFilesSeen++;
      // Source → ekstraksi penuh; meta (config/skema/migrasi) → simpul file saja.
      // Secret (.env, *.pem, …) tak pernah terindeks.
      const source = isSourceFile(abs);
      const meta = !source && isIndexableMetaFile(rel);
      if (!source && !meta) continue;
      if (source) sourceFiles++;
      else metaFiles++;
      seenPaths.add(rel);

      let buf: Buffer;
      try {
        buf = fs.readFileSync(abs);
      } catch {
        continue;
      }
      const hash = hashContent(buf);
      const language = source ? detectLanguage(abs) : "other";
      const row = getStmt.get(rel) as { id: number; hash: string } | undefined;
      if (!row) {
        const r = insertStmt.run(rel, language, hash, buf.length);
        if (source) {
          pending.push({ fileId: Number(r.lastInsertRowid), rel, content: buf.toString("utf8") });
        } else {
          indexMetaFile(db, Number(r.lastInsertRowid), rel);
          metaChanged.push({ fileId: Number(r.lastInsertRowid), rel });
        }
        inserted++;
      } else if (row.hash !== hash || backfill) {
        updateStmt.run(hash, buf.length, language, rel);
        if (source) {
          pending.push({ fileId: row.id, rel, content: buf.toString("utf8") });
        } else {
          indexMetaFile(db, row.id, rel);
          metaChanged.push({ fileId: row.id, rel });
        }
        updated++;
      } else {
        unchanged++;
      }
    }

    // Remove stale rows (deleted / newly ignored files).
    const existing = db
      .prepare(`SELECT path FROM files`)
      .all() as { path: string }[];
    const delStmt = db.prepare(`DELETE FROM files WHERE path = ?`);
    let removed = 0;
    for (const r of existing) {
      if (!seenPaths.has(r.path)) {
        delStmt.run(r.path);
        removed++;
      }
    }

    // Phase 1: symbols for all changed files.
    const phased = pending.map((p) => ({
      ...p,
      ...indexFileSymbols(db, p.fileId, p.rel, p.content),
    }));
    // Phase 2: relations (all symbols now visible globally).
    for (const p of phased) {
      indexFileRelations(db, p.fileId, p.rel, p.extraction, p.fileSym);
    }

    // Phase 3: framework adapters (FR-13) atas file yang berubah —
    // source (app/, pages/) maupun meta (schema.prisma).
    const adapterChanged = [
      ...pending.map((p) => ({ fileId: p.fileId, rel: p.rel })),
      ...metaChanged,
    ];
    const adapterRun = runAdapters(db, repoRoot, adapterChanged);

    db.prepare(
      `INSERT INTO meta(key, value) VALUES ('last_scan', datetime('now'))
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    ).run();

    linkTests(db);
    cleanupIndex(db);

    // GRAPH.md: tulis ulang hanya bila graph berubah (file berubah atau
    // adapter menambah simbol/relasi). Tanpa perubahan → file tak tersentuh.
    const graphDirty =
      inserted + updated + removed > 0 ||
      adapterRun.symbols > 0 ||
      adapterRun.relations > 0;
    const graphWritten = writeGraphMdIfChanged(db, repoRoot, graphDirty);
    let visualWritten = false;
    if (graphDirty) {
      try {
        const model = buildVisualModel(db);
        const html = renderHtml(
          model,
          path.basename(path.resolve(repoRoot)),
          new Date().toISOString().slice(0, 19).replace("T", " ")
        );
        fs.mkdirSync(dataDir(repoRoot), { recursive: true });
        fs.writeFileSync(path.join(dataDir(repoRoot), GRAPH_HTML_NAME), html);
        visualWritten = true;
      } catch {
        visualWritten = false;
      }
    }

    const symbols = (
      db.prepare(`SELECT COUNT(*) AS n FROM symbols`).get() as { n: number }
    ).n;
    const relationships = (
      db.prepare(`SELECT COUNT(*) AS n FROM relationships`).get() as { n: number }
    ).n;

    return {
      repoRoot,
      totalFilesSeen,
      sourceFiles,
      metaFiles,
      symbols,
      relationships,
      adapters: adapterRun.adapters,
      graphWritten,
      visualWritten,
      inserted,
      updated,
      unchanged,
      removed,
      durationMs: Date.now() - started,
    };
  } finally {
    db.close();
  }
}
