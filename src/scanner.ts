import fs from "node:fs";
import path from "node:path";
import { detectLanguage, isSourceFile } from "./languages.js";
import { grammarForPath } from "./extract/treeSitter.js";
import { prepareTreeSitter } from "./treesitter.js";
import { hashContent, openDb, dataDir } from "./db.js";
import { loadIgnoreRules, isIgnored } from "./ignore.js";
import {
  indexFileSymbols,
  indexFileRelations,
  indexMetaFile,
  linkTests,
  seedExportRelations,
  type ModuleResolverContext,
} from "./indexer.js";
import { discoverWorkspaces } from "./workspace.js";
import { cleanupIndex } from "./retrieval/symbolIndex.js";
import { ensureDefaultFiles } from "./retrieval/config.js";
import { isIndexableMetaFile, loadProtectedPatterns } from "./scope/protected.js";
import { runAdapters } from "./adapters/index.js";
import { ensureHistoryIndex } from "./retrieval/history/extractor.js";
import { syncCommitFts } from "./retrieval/history/index.js";
import { logError } from "./log.js";
import { writeGraphMdIfChanged } from "./graph/export.js";
import { buildVisualModel, renderHtml, GRAPH_HTML_NAME } from "./graph/visual.js";
import { writeArchaeologyIfAbsent } from "./archaeology.js";
import { ensureCycles } from "./graph/cycles.js";
import { changedFilesVsHead } from "./retrieval/gitChanged.js";
import { detectLsp, enrichRelationsWithLsp, type LspStatus } from "./extract/lsp.js";

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
  /** Hanya terisi bila `--lsp` diberikan (deteksi best-effort, tak wajib). */
  lsp?: LspStatus;
  lspUpgraded?: number;
}

function toPosixRel(repoRoot: string, abs: string): string {
  return path.relative(repoRoot, abs).split(path.sep).join("/");
}

function walk(
  repoRoot: string,
  absDir: string,
  rules: ReturnType<typeof loadIgnoreRules>,
  out: string[]
): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(absDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const abs = path.join(absDir, e.name);
    const rel = toPosixRel(repoRoot, abs);
    if (e.isDirectory()) {
      // Skip symlinked dirs to avoid loops and skip ignored directories
      // (node_modules, .git, target, bin, obj, dist, build, .next, etc.)
      if (e.isSymbolicLink()) continue;
      if (isIgnored(rel + "/", rules) || isIgnored(rel, rules)) continue;
      walk(repoRoot, abs, rules, out);
    } else if (e.isFile()) {
      if (!isIgnored(rel, rules)) {
        out.push(abs);
      }
    }
  }
}

export interface ScanRepositoryOptions {
  /** Bila true, hanya file yang berubah menurut git (+ file baru belum terindeks) yang diproses. */
  changedOnly?: boolean;
  /** Daftar path relatif eksplisit (mis. dari watcher) untuk scan inkremental tanpa walk penuh. */
  changedPaths?: string[];
  /** Bila true, deteksi LSP opsional (tsserver/gopls/pyright) best-effort. Default: off. */
  lsp?: boolean;
}

export async function scanRepository(
  repoRoot: string,
  opts?: ScanRepositoryOptions
): Promise<ScanStats> {
  const started = Date.now();
  const rules = loadIgnoreRules(repoRoot);
  const db = openDb(repoRoot);
  // Deklarasi di luar `try` supaya `finally` bisa ROLLBACK saat body gagal.
  let inTx = false;
  try {
    // DI DALAM try: kalau ensureDefaultFiles melempar, `finally` tetap jalan
    // dan handle SQLite tidak bocor (di Windowshandle yang bocor menahan
    // scopecairn.db-wal).
    ensureDefaultFiles(repoRoot);
    const known = new Set<string>();
    try {
      for (const r of db.prepare(`SELECT path FROM files`).all() as { path: string }[]) {
        known.add(r.path);
      }
    } catch {
      // DB kosong / skema lama — fallback ke walk penuh.
    }
    const dbEmpty = known.size === 0;

    const explicitPaths = (opts?.changedPaths ?? [])
      .map((p) => p.replace(/\\/g, "/").replace(/^\.\//, ""))
      .filter(Boolean);
    const useExplicitPaths = explicitPaths.length > 0 && !dbEmpty;

    const changedOnly = opts?.changedOnly === true;
    let changedSet: Set<string> | null = null;
    const allAbs: string[] = [];
    let scanAbs: string[] = [];

    if (useExplicitPaths) {
      changedSet = new Set<string>();
      const absSeen = new Set<string>();
      for (const rel of explicitPaths) {
        if (isIgnored(rel, rules)) continue;
        const abs = path.join(repoRoot, ...rel.split("/"));
        try {
          const st = fs.statSync(abs);
          if (st.isFile()) {
            changedSet.add(rel);
            if (!absSeen.has(abs)) {
              absSeen.add(abs);
              scanAbs.push(abs);
            }
          } else if (st.isDirectory()) {
            if (isIgnored(rel + "/", rules)) continue;
            const subAbs: string[] = [];
            walk(repoRoot, abs, rules, subAbs);
            for (const fAbs of subAbs) {
              if (!absSeen.has(fAbs)) {
                absSeen.add(fAbs);
                scanAbs.push(fAbs);
              }
              changedSet.add(toPosixRel(repoRoot, fAbs));
            }
            const prefix = rel + "/";
            for (const k of known) {
              if (k.startsWith(prefix)) changedSet.add(k);
            }
          }
        } catch {
          // File/direktori dihapus — tandai di changedSet agar dibersihkan dari DB
          changedSet.add(rel);
          const prefix = rel + "/";
          for (const k of known) {
            if (k.startsWith(prefix)) changedSet.add(k);
          }
        }
      }
    } else {
      if (changedOnly) {
        try {
          changedSet = new Set(
            changedFilesVsHead(repoRoot).map((p) => p.replace(/\\/g, "/"))
          );
        } catch {
          changedSet = new Set<string>();
        }
      }
      walk(repoRoot, repoRoot, rules, allAbs);
      scanAbs = allAbs;
      if (changedOnly && changedSet && !dbEmpty) {
        // Hanya proses file git-dirty + file yang belum ada di DB (aman untuk
        // scan pertama pasca-commit); sisanya di-skip tanpa merusak seenPaths.
        scanAbs = allAbs.filter((abs) => {
          const rel = toPosixRel(repoRoot, abs);
          return changedSet!.has(rel) || !known.has(rel);
        });
      }
    }
    await prepareTreeSitter(scanAbs
      .filter((abs) => isSourceFile(abs))
      .map((abs) => grammarForPath(abs))
      .filter((name): name is string => name !== null));

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
    const protectedPatterns = loadProtectedPatterns(repoRoot);

    // Semua mutasi DB berikut dibungkus SATU transaksi. Sebelumnya tiap
    // INSERT/DELETE auto-commit, padahal `files.hash` ditulis lebih dulu
    // (baris ~144) sebelum simbol & relasi diekstrak. Kalau proses mati di
    // tengah, file sudah tercatat "sama hash"-nya sehingga scan berikutnya
    // masuk cabang `unchanged` dan TIDAK PERNAH diekstrak ulang → file
    // permanen terindeks dengan 0 simbol, 0 relasi, tanpa error.
    //
    // Side-effect berkas (GRAPH.md, GRAPH.html) sengaja DI LUAR transaksi:
    // penulisan berkas tidak bisa di-rollback dan akan mendahului DB commit
    // kalau ikut di dalam.
    try {
      db.exec("BEGIN");
      inTx = true;
    } catch {
      inTx = false; // sudah dalam transaksi (nested) — biarkan
    }

    // Backfill: DBs lama tanpa graph/FTS — re-extract semuanya sekali.
    // Hanya sekali per DB (ditandai meta.backfill_done) agar repo yang
    // sah tanpa simbol/FTS tidak memicu full re-scan tiap scan.
    const backfillDone = db
      .prepare(`SELECT value FROM meta WHERE key = 'backfill_done'`)
      .get() as { value: string } | undefined;
    const symbolCount = (
      db.prepare(`SELECT COUNT(*) AS n FROM symbols`).get() as { n: number }
    ).n;
    let ftsCount = 0;
    try {
      ftsCount = (db.prepare(`SELECT COUNT(*) AS n FROM symbol_index`).get() as { n: number }).n;
    } catch {
      ftsCount = 0;
    }
    const backfill = !backfillDone && (symbolCount === 0 || ftsCount === 0);
    const extractorVersion = "tree-sitter-wasms-0.1.13-v5";
    const indexedVersion = db.prepare(`SELECT value FROM meta WHERE key = 'extractor_version'`)
      .get() as { value: string } | undefined;
    const parserChanged = indexedVersion?.value !== extractorVersion;
    // Backfill/parser-change butuh re-extract penuh — batalkan filter changedOnly / changedPaths.
    if (backfill || parserChanged) {
      if (useExplicitPaths && allAbs.length === 0) {
        walk(repoRoot, repoRoot, rules, allAbs);
      }
      if (scanAbs.length < allAbs.length || useExplicitPaths) {
        scanAbs = allAbs;
        changedSet = null;
      }
    }

    // Two-phase indexing: phase 1 inserts symbols for all changed files,
    // phase 2 resolves relations — cross-file edges are order-independent.
    const pending: { fileId: number; rel: string; content: string; language: string }[] = [];
    const metaChanged: { fileId: number; rel: string; content: string }[] = [];

    for (const abs of scanAbs) {
      const rel = toPosixRel(repoRoot, abs);
      if (isIgnored(rel, rules)) continue;
      totalFilesSeen++;
      // Source → ekstraksi penuh; meta (config/skema/migrasi) → simpul file saja.
      // Secret (.env, *.pem, …) tak pernah terindeks.
      const source = isSourceFile(abs);
      const meta = !source && isIndexableMetaFile(rel, protectedPatterns);
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
          pending.push({ fileId: Number(r.lastInsertRowid), rel, content: buf.toString("utf8"), language });
        } else {
          indexMetaFile(db, Number(r.lastInsertRowid), rel);
          metaChanged.push({ fileId: Number(r.lastInsertRowid), rel, content: buf.toString("utf8") });
        }
        inserted++;
      } else if (row.hash !== hash || backfill || parserChanged) {
        updateStmt.run(hash, buf.length, language, rel);
        if (source) {
          pending.push({ fileId: row.id, rel, content: buf.toString("utf8"), language });
        } else {
          indexMetaFile(db, row.id, rel);
          metaChanged.push({ fileId: row.id, rel, content: buf.toString("utf8") });
        }
        updated++;
      } else {
        unchanged++;
      }
    }

    // Remove stale rows (deleted / newly ignored files). Mode changedOnly
    // hanya boleh menghapus path git-dirty yang kini hilang dari disk.
    const existing = db
      .prepare(`SELECT path FROM files`)
      .all() as { path: string }[];
    const delStmt = db.prepare(`DELETE FROM files WHERE path = ?`);
    let removed = 0;
    for (const r of existing) {
      if (!seenPaths.has(r.path)) {
        if (changedSet && !changedSet.has(r.path)) continue;
        delStmt.run(r.path);
        removed++;
      }
    }

    // Phase 1: symbols for all changed files.
    const phased = pending.map((p) => ({
      ...p,
      ...indexFileSymbols(db, p.fileId, p.rel, p.content),
    }));
    // Phase 2: relations (seed EXPORTS dulu agar multi-hop barrel order-independent).
    const resolverCtx: ModuleResolverContext = {
      repoRoot,
      workspaces: discoverWorkspaces(repoRoot),
      tsConfigCache: new Map(),
    };
    for (const p of phased) {
      seedExportRelations(db, p.fileId, p.rel, p.extraction, p.fileSym, resolverCtx);
    }
    for (const p of phased) {
      indexFileRelations(db, p.fileId, p.rel, p.extraction, p.fileSym, resolverCtx);
    }

    // LSP opsional (default off): deteksi biner dan tingkatkan edge AMBIGUOUS bila tersedia.
    let lsp: LspStatus | undefined;
    let lspUpgraded = 0;
    if (opts?.lsp) {
      try {
        lsp = detectLsp();
        lspUpgraded = await enrichRelationsWithLsp(db, repoRoot, pending, lsp);
      } catch {
        lsp = undefined;
      }
    }

    // Phase 3: framework adapters (FR-13) atas file yang berubah —
    // source (app/, pages/) maupun meta (schema.prisma).
    const adapterChanged = [
      ...pending.map((p) => ({ fileId: p.fileId, rel: p.rel })),
      ...metaChanged.map((p) => ({ fileId: p.fileId, rel: p.rel })),
    ];
    const contentMap = new Map<number, string>();
    for (const p of pending) contentMap.set(p.fileId, p.content);
    for (const p of metaChanged) contentMap.set(p.fileId, p.content);
    const adapterRun = runAdapters(db, repoRoot, adapterChanged, contentMap);

    db.prepare(
      `INSERT INTO meta(key, value) VALUES ('last_scan', datetime('now'))
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    ).run();
    db.prepare(
      `INSERT INTO meta(key, value) VALUES ('backfill_done', '1')
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    ).run();
    db.prepare(
      `INSERT INTO meta(key, value) VALUES ('extractor_version', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    ).run(extractorVersion);
    const delta: Record<string, number> = {
      inserted,
      updated,
      unchanged,
      removed,
      sourceFiles,
      metaFiles,
      durationMs: Date.now() - started,
    };
    try {
      db.prepare(
        `INSERT INTO meta(key, value) VALUES ('last_scan_delta', ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`
      ).run(JSON.stringify(delta));
    } catch {
      // delta bersifat opsional — abaikan kegagalan serialisasi
    }

    linkTests(db);
    cleanupIndex(db);
    try {
      ensureCycles(db);
    } catch (err) {
      logError("cycles", err, repoRoot);
    }

    // Cache fan-in untuk ranking retrieval. Satu lintasan GROUP BY di akhir
    // scan (bukan di setiap retrieve()). Diletakkan SEBELUM COMMIT supaya
    // cache dan tabel relationships selalu konsisten — kalau scan gagal di
    // tengah, ROLLBACK mengembalikan keduanya.
    try {
      db.exec(`DELETE FROM fanin`);
      db.exec(
        `INSERT INTO fanin(node_id, n)
         SELECT target_id, COUNT(*) FROM relationships GROUP BY target_id`
      );
    } catch (err) {
      logError("fanin", err, repoRoot);
    }

    // Analogi riwayat: indeks git inkremental (best-effort; repo tanpa git
    // atau clone dangkal tetap sukses, hanya dilaporkan di doctor).
    try {
      const hist = ensureHistoryIndex(db, repoRoot);
      if (hist.available && hist.shas.length > 0) {
        try {
          syncCommitFts(db, hist.shas);
        } catch (err) {
          logError("history", err, repoRoot);
        }
      }
    } catch (err) {
      logError("history", err, repoRoot);
    }

    if (inTx) {
      db.exec("COMMIT");
      inTx = false;
    }

    // GRAPH.md: tulis ulang hanya bila graph berubah (file berubah atau
    // adapter menambah simbol/relasi). Tanpa perubahan → file tak tersentuh.
    const graphDirty =
      inserted + updated + removed > 0 ||
      adapterRun.symbols > 0 ||
      adapterRun.relations > 0;
    const graphWritten = writeGraphMdIfChanged(db, repoRoot, graphDirty);
    if (graphDirty) writeArchaeologyIfAbsent(repoRoot);
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
      ...(lsp ? { lsp, lspUpgraded } : {}),
    };
  } finally {
    if (inTx) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // koneksi sudah rusak / transaksi sudah selesai
      }
    }
    db.close();
  }
}
