import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { AdapterFile, FrameworkAdapter, QueryEdge } from "./types.js";
import { cleanupOrphans } from "./types.js";
import { prismaAdapter } from "./prisma.js";
import { nextjsAdapter, derivePrismaQueries } from "./nextjs.js";
import { drizzleAdapter, deriveDrizzleQueries } from "./drizzle.js";
import { expressAdapter } from "./express.js";
import { fastifyAdapter } from "./fastify.js";
import { railsAdapter } from "./rails.js";
import { laravelAdapter } from "./laravel.js";
import { springAdapter } from "./spring.js";
import { golangAdapter } from "./golang.js";
import { fastapiAdapter } from "./fastapi.js";
import {
  sqlalchemyAdapter,
  deriveSqlAlchemyQueries,
} from "./sqlalchemy.js";
import { vueAdapter } from "./vue.js";
import { nestjsAdapter } from "./nestjs.js";
import { djangoAdapter } from "./django.js";
import { apiCallsRelevant, deriveApiCalls } from "./apiCalls.js";
import { syncFileIndex } from "../retrieval/symbolIndex.js";
import { logError } from "../log.js";

// Registrasi adapter (FR-13): kontribusi komunitas = file baru + satu baris di sini.
// Urutan penting: prisma/drizzle/sqlalchemy dulu (menyediakan simbol model untuk QUERIES).
const ADAPTERS: FrameworkAdapter[] = [
  prismaAdapter,
  drizzleAdapter,
  sqlalchemyAdapter,
  nextjsAdapter,
  expressAdapter,
  fastifyAdapter,
  fastapiAdapter,
  nestjsAdapter,
  djangoAdapter,
  vueAdapter,
  railsAdapter,
  laravelAdapter,
  springAdapter,
  golangAdapter,
];

export function detectAdapters(files: string[], repoRoot?: string): FrameworkAdapter[] {
  return ADAPTERS.filter((a) => {
    try {
      if (!a.detect(files)) return false;
      if (repoRoot && a.confirm) return a.confirm(repoRoot, files);
      return true;
    } catch (err) {
      logError("adapters", err, repoRoot);
      return false;
    }
  });
}

/**
 * Jalankan adapter terdeteksi atas file yang berubah. Kembalikan ringkasan.
 * `contentByFileId` (opsional, dari scanner yang sudah membaca file) diutamakan
 * agar file yang baru dibaca tidak dibaca ulang dari disk.
 */
export function runAdapters(
  db: DatabaseSync,
  repoRoot: string,
  changed: { fileId: number; rel: string }[],
  contentByFileId?: Map<number, string>
): { adapters: string[]; symbols: number; relations: number } {
  const allFiles = (
    db.prepare(`SELECT path FROM files`).all() as { path: string }[]
  ).map((r) => r.path);
  const active = detectAdapters(allFiles, repoRoot);
  if (active.length === 0) return { adapters: [], symbols: 0, relations: 0 };

  let symbols = 0;
  let relations = 0;
  const touched = new Set<number>();
  const readContent = (fileId: number, rel: string): string | null => {
    const cached = contentByFileId?.get(fileId);
    if (cached !== undefined) return cached;
    try {
      return fs.readFileSync(path.join(repoRoot, ...rel.split("/")), "utf8");
    } catch {
      return null;
    }
  };
  for (const adapter of active) {
    const inputs: AdapterFile[] = [];
    for (const c of changed) {
      if (!adapter.relevant(c.rel)) continue;
      const content = readContent(c.fileId, c.rel);
      if (content === null) continue;
      inputs.push({ fileId: c.fileId, rel: c.rel, content });
    }
    if (inputs.length === 0) continue;
    try {
      const r = adapter.apply({ db, repoRoot }, inputs);
      symbols += r.symbols;
      relations += r.relations;
      for (const i of inputs) touched.add(i.fileId);
    } catch (err) {
      logError("adapters", err, repoRoot);
    }
  }
  // Simbol adapter disisip setelah sync FTS fase 1 — sinkronkan ulang.
  for (const fileId of touched) {
    const row = db.prepare(`SELECT path FROM files WHERE id = ?`).get(fileId) as
      | { path: string }
      | undefined;
    if (row) {
      try {
        syncFileIndex(db, fileId, row.path);
      } catch (err) {
        logError("adapters", err, repoRoot);
      }
    }
  }
  // QUERIES anti-basi: satu pass terpadu. Bila file model/schema berubah,
  // target baru bisa muncul → pass global atas SEMUA file relevan; bila tidak,
  // cukup file yang berubah (file tak berubah tidak di-reparse).
  // Per-file edge QUERIES dihapus lalu diturunkan ulang dari parser query
  // aktif. Refresh per-adapter akan menghapus edge adapter lain (mis. Prisma +
  // Drizzle dalam satu repo JS).
  const derivers: {
    relevant: (rel: string) => boolean;
    derive: (
      db: DatabaseSync,
      fileId: number,
      content: string
    ) => QueryEdge[];
  }[] = [];
  if (active.some((a) => a.id === "nextjs")) {
    derivers.push({ relevant: nextjsAdapter.relevant, derive: derivePrismaQueries });
  }
  if (active.some((a) => a.id === "drizzle")) {
    derivers.push({ relevant: drizzleAdapter.relevant, derive: deriveDrizzleQueries });
  }
  if (active.some((a) => a.id === "sqlalchemy")) {
    derivers.push({
      relevant: sqlalchemyAdapter.relevant,
      derive: deriveSqlAlchemyQueries,
    });
  }
  const looksLikeModel = (rel: string, content?: string): boolean => {
    if (rel.endsWith("schema.prisma")) return true;
    if (/(^|\/)drizzle\.config\./.test(rel) || /(^|\/)drizzle\//.test(rel)) return true;
    if (/(^|\/)(db|drizzle)\/.*schema.*/.test(rel)) return true;
    if (/(^|\/)models\.py$/.test(rel) || /(^|\/)models\//.test(rel)) return true;
    if (content) {
      if (content.includes("__tablename__")) return true;
      if (
        content.includes("pgTable(") ||
        content.includes("sqliteTable(") ||
        content.includes("mysqlTable(")
      )
        return true;
    }
    return false;
  };
  const looksLikeRoute = (rel: string, content?: string): boolean => {
    if (/(^|\/)app\//.test(rel) || /(^|\/)pages\//.test(rel)) return true;
    if (/(^|\/)routes?\//.test(rel)) return true;
    if (!content) return false;
    return (
      content.includes(".get(") && content.includes("/api") ||
      content.includes("APIRouter") ||
      content.includes("@Controller") ||
      content.includes("@app.") ||
      content.includes("@router.")
    );
  };
  if (derivers.length > 0) {
    try {
      const schemaChanged = changed.some((c) =>
        contentByFileId ? looksLikeModel(c.rel, contentByFileId.get(c.fileId))
        : prismaAdapter.relevant(c.rel) || drizzleAdapter.relevant(c.rel) || sqlalchemyAdapter.relevant(c.rel)
      );
      const all: { id: number; path: string }[] = schemaChanged
        ? (db.prepare(`SELECT id, path FROM files`).all() as { id: number; path: string }[])
        : changed.map((c) => ({ id: c.fileId, path: c.rel }));
      const del = db.prepare(
        `DELETE FROM relationships WHERE relationship_type = 'QUERIES' AND source_id IN (SELECT id FROM symbols WHERE file_id = ?)`
      );
      const ins = db.prepare(
        `INSERT INTO relationships(source_id, target_id, relationship_type, weight, confidence, evidence)
         VALUES (?, ?, 'QUERIES', ?, ?, 'INFERRED')`
      );
      for (const r of all) {
        if (!derivers.some((d) => d.relevant(r.path))) continue;
        const content = readContent(r.id, r.path);
        if (content === null) continue;
        del.run(r.id);
        for (const d of derivers) {
          for (const e of d.derive(db, r.id, content)) {
            ins.run(e.callerId, e.targetId, e.weight, e.confidence);
            relations++;
          }
        }
      }
    } catch (err) {
      logError("adapters", err, repoRoot);
    }
  }
  // CALLS_API lintas batas: post-pass atas file JS/TS yang berubah; bila file
  // route berubah (target baru) → pass global agar call tertunda me-resolve.
  try {
    const routeChanged = changed.some((c) =>
      contentByFileId
        ? looksLikeRoute(c.rel, contentByFileId.get(c.fileId))
        : active.some((a) => a.relevant(c.rel))
    );
    const all: { id: number; path: string }[] = routeChanged
      ? (db.prepare(`SELECT id, path FROM files`).all() as { id: number; path: string }[])
      : changed.map((c) => ({ id: c.fileId, path: c.rel }));
    const hasClient = all.some((r) => apiCallsRelevant(r.path));
    if (hasClient) {
      const delApi = db.prepare(
        `DELETE FROM relationships WHERE relationship_type = 'CALLS_API' AND source_id IN (SELECT id FROM symbols WHERE file_id = ?)`
      );
      const insApi = db.prepare(
        `INSERT INTO relationships(source_id, target_id, relationship_type, weight, confidence, evidence)
         VALUES (?, ?, 'CALLS_API', ?, ?, ?)`
      );
      for (const r of all) {
        if (!apiCallsRelevant(r.path)) continue;
        const content = readContent(r.id, r.path);
        if (content === null) continue;
        try {
          delApi.run(r.id);
        } catch (err) {
          logError("adapters", err, repoRoot);
          continue;
        }
        let edges: ReturnType<typeof deriveApiCalls>;
        try {
          edges = deriveApiCalls(db, r.id, content, r.path);
        } catch (err) {
          logError("adapters", err, repoRoot);
          continue;
        }
        for (const e of edges) {
          try {
            insApi.run(e.callerId, e.targetId, e.weight, e.confidence, e.evidence);
            relations++;
          } catch (err) {
            logError("adapters", err, repoRoot);
          }
        }
      }
    }
  } catch (err) {
    logError("adapters", err, repoRoot);
  }
  // Jaring pengaman: buang edge/metrik yang menunjuk simbol hilang.
  try {
    cleanupOrphans(db);
  } catch (err) {
    logError("adapters", err, repoRoot);
  }
  return { adapters: active.map((a) => a.id), symbols, relations };
}