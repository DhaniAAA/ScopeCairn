import fs from "node:fs";
import path from "node:path";
import { dataDir, dbPath, openDb } from "../db.js";
import { detectAdapters } from "../adapters/index.js";

export function cmdStatus(repoRoot: string): void {
  const dir = dataDir(repoRoot);
  if (!fs.existsSync(path.join(dir, "scopecairn.db"))) {
    console.log("ScopeCairn");
    console.log("Status: NOT INITIALIZED (run `scopecairn scan`)");
    return;
  }
  const db = openDb(repoRoot);
  try {
    const files = (db.prepare(`SELECT COUNT(*) AS n FROM files`).get() as { n: number }).n;
    const byLang = db
      .prepare(`SELECT language, COUNT(*) AS n FROM files GROUP BY language ORDER BY n DESC`)
      .all() as { language: string; n: number }[];
    const lastScan =
      (db.prepare(`SELECT value FROM meta WHERE key = 'last_scan'`).get() as
        | { value: string }
        | undefined)?.value ?? "-";
    console.log("ScopeCairn");
    console.log(`Index: ${dbPath(repoRoot)}`);
    console.log(`Files indexed: ${files}`);
    for (const r of byLang) console.log(`  ${r.language}: ${r.n}`);
    try {
      const symbols = (db.prepare(`SELECT COUNT(*) AS n FROM symbols`).get() as { n: number }).n;
      const rels = (db.prepare(`SELECT COUNT(*) AS n FROM relationships`).get() as { n: number }).n;
      console.log(`Symbols: ${symbols}`);
      console.log(`Relationships: ${rels}`);
      try {
        const fts = (db.prepare(`SELECT COUNT(*) AS n FROM symbol_index`).get() as { n: number }).n;
        console.log(`Symbol index (FTS5): ${fts} rows`);
      } catch {
        console.log(`Symbol index (FTS5): -`);
      }
    } catch {
      // pre-Fase-2 DB without graph tables
    }
    console.log(`Last scan: ${lastScan}`);
    try {
      const paths = (
        db.prepare(`SELECT path FROM files`).all() as { path: string }[]
      ).map((r) => r.path);
      const adapters = detectAdapters(paths, repoRoot);
      if (adapters.length > 0) {
        console.log(`Adapters: ${adapters.map((a) => a.id).join(", ")}`);
      }
    } catch {
      // ignore
    }
    try {
      const inv = db
        .prepare(
          `SELECT command, COUNT(*) AS n FROM invocations GROUP BY command ORDER BY n DESC`
        )
        .all() as { command: string; n: number }[];
      const total = inv.reduce((a, r) => a + r.n, 0);
      if (total > 0) {
        console.log(`Invocations: ${total} (${inv.map((r) => `${r.command} ${r.n}`).join(", ")})`);
      }
    } catch {
      // pre-Fase-5 DB without invocations table
    }
  } finally {
    db.close();
  }
}
