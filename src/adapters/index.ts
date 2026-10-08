import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { AdapterFile, FrameworkAdapter, QueryEdge } from "./types.js";
import { cleanupOrphans } from "./types.js";
import { prismaAdapter } from "./prisma.js";
import { nextjsAdapter, derivePrismaQueries } from "./nextjs.js";
import { drizzleAdapter, deriveDrizzleQueries } from "./drizzle.js";
import { expressAdapter } from "./express.js";
import { fastapiAdapter } from "./fastapi.js";
import {
  sqlalchemyAdapter,
  deriveSqlAlchemyQueries,
} from "./sqlalchemy.js";
import { vueAdapter } from "./vue.js";
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
  fastapiAdapter,
  vueAdapter,
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

/** Jalankan adapter terdeteksi atas file yang berubah. Kembalikan ringkasan. */
export function runAdapters(
  db: DatabaseSync,
  repoRoot: string,
  changed: { fileId: number; rel: string }[]
): { adapters: string[]; symbols: number; relations: number } {
  const allFiles = (
    db.prepare(`SELECT path FROM files`).all() as { path: string }[]
  ).map((r) => r.path);
  const active = detectAdapters(allFiles, repoRoot);
  if (active.length === 0) return { adapters: [], symbols: 0, relations: 0 };

  let symbols = 0;
  let relations = 0;
  const touched = new Set<number>();
  for (const adapter of active) {
    const inputs: AdapterFile[] = [];
    for (const c of changed) {
      if (!adapter.relevant(c.rel)) continue;
      const abs = path.join(repoRoot, ...c.rel.split("/"));
      let content: string;
      try {
        content = fs.readFileSync(abs, "utf8");
      } catch {
        continue;
      }
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
  // QUERIES anti-basi: satu pass terpadu atas SEMUA file relevan.
  // Per-file edge QUERIES dihapus lalu diturunkan ulang dari SEMUA
  // parser query aktif. Refresh per-adapter akan menghapus edge
  // adapter lain (mis. Prisma + Drizzle dalam satu repo JS).
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
  if (derivers.length > 0) {
    try {
      const all = db
        .prepare(`SELECT id, path FROM files`)
        .all() as { id: number; path: string }[];
      const del = db.prepare(
        `DELETE FROM relationships WHERE relationship_type = 'QUERIES' AND source_id IN (SELECT id FROM symbols WHERE file_id = ?)`
      );
      const ins = db.prepare(
        `INSERT INTO relationships(source_id, target_id, relationship_type, weight, confidence, evidence)
         VALUES (?, ?, 'QUERIES', ?, ?, 'INFERRED')`
      );
      for (const r of all) {
        if (!derivers.some((d) => d.relevant(r.path))) continue;
        let content: string;
        try {
          content = fs.readFileSync(path.join(repoRoot, ...r.path.split("/")), "utf8");
        } catch {
          continue;
        }
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
  // Jaring pengaman: buang edge/metrik yang menunjuk simbol hilang.
  try {
    cleanupOrphans(db);
  } catch (err) {
    logError("adapters", err, repoRoot);
  }
  return { adapters: active.map((a) => a.id), symbols, relations };
}