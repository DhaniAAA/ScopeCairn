import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { AdapterFile, FrameworkAdapter } from "./types.js";
import { prismaAdapter } from "./prisma.js";
import { nextjsAdapter, refreshQueries } from "./nextjs.js";
import { drizzleAdapter, refreshDrizzleQueries } from "./drizzle.js";
import { syncFileIndex } from "../retrieval/symbolIndex.js";

// Registrasi adapter (FR-13): kontribusi komunitas = file baru + satu baris di sini.
// Urutan penting: prisma/drizzle dulu (menyediakan simbol model untuk QUERIES).
const ADAPTERS: FrameworkAdapter[] = [prismaAdapter, drizzleAdapter, nextjsAdapter];

export function detectAdapters(files: string[], repoRoot?: string): FrameworkAdapter[] {
  return ADAPTERS.filter((a) => {
    try {
      if (!a.detect(files)) return false;
      if (repoRoot && a.confirm) return a.confirm(repoRoot, files);
      return true;
    } catch {
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
    } catch {
      // Adapter tak boleh menggagalkan scan.
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
      } catch {
        // ignore
      }
    }
  }
  // QUERIES anti-basi: turunkan ulang atas SEMUA file relevan
  // (murah: regex), agar model/tabel baru langsung ter-resolve tanpa rebuild.
  const refreshTargets = (
    id: string,
    relevant: (rel: string) => boolean,
    refresh: (
      db: DatabaseSync,
      files: { fileId: number; rel: string; content: string }[]
    ) => number
  ): void => {
    if (!active.some((a) => a.id === id)) return;
    try {
      const all = (
        db.prepare(`SELECT id, path FROM files`).all() as { id: number; path: string }[]
      ).filter((r) => relevant(r.path));
      const inputs: { fileId: number; rel: string; content: string }[] = [];
      for (const r of all) {
        try {
          inputs.push({
            fileId: r.id,
            rel: r.path,
            content: fs.readFileSync(path.join(repoRoot, ...r.path.split("/")), "utf8"),
          });
        } catch {
          // hilang di disk — lewati
        }
      }
      relations += refresh(db, inputs);
    } catch {
      // ignore
    }
  };
  refreshTargets("nextjs", nextjsAdapter.relevant, refreshQueries);
  refreshTargets("drizzle", drizzleAdapter.relevant, refreshDrizzleQueries);
  return { adapters: active.map((a) => a.id), symbols, relations };
}