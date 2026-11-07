import fs from "node:fs";
import path from "node:path";
import { dataDir, dbPath, openDb } from "../db.js";
import { detectAdapters } from "../adapters/index.js";
import { collectUsage, renderUsage } from "../usage.js";
import { cmdDoctor } from "./doctor.js";
import { cmdDashboard } from "./dashboard.js";

export interface StatusOptions {
  doctor?: boolean;
  verbose?: boolean;
  html?: boolean;
  dashboard?: boolean;
  usage?: boolean;
  out?: string;
}

export async function cmdStatus(repoRoot: string, opts: StatusOptions = {}): Promise<void> {
  if (opts.doctor) {
    await cmdDoctor(repoRoot, { verbose: opts.verbose });
    return;
  }
  if (opts.html || opts.dashboard) {
    cmdDashboard(repoRoot, { out: opts.out });
    return;
  }

  const dir = dataDir(repoRoot);
  if (!fs.existsSync(path.join(dir, "scopecairn.db"))) {
    console.log("ScopeCairn");
    console.log("Status: NOT INITIALIZED (run `scopecairn scan`)");
    return;
  }
  const db = openDb(repoRoot);
  try {
    if (opts.usage) {
      console.log(renderUsage(collectUsage(db)));
      return;
    }
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
      const deltaRow = db.prepare(`SELECT value FROM meta WHERE key = 'last_scan_delta'`).get() as { value: string } | undefined;
      if (deltaRow) {
        try {
          const d = JSON.parse(deltaRow.value) as Record<string, number>;
          console.log(
            `Scan delta: +${d.inserted ?? 0} new, ~${d.updated ?? 0} updated, =${d.unchanged ?? 0} unchanged, -${d.removed ?? 0} removed (${(Number(d.durationMs ?? 0) / 1000).toFixed(2)}s)`
          );
        } catch {
          console.log(`Scan delta: (unparseable)`);
        }
      }
    } catch {
      // meta tak tersedia — lewati diam-diam
    }
    try {
      let faninN = -1;
      let metricsN = -1;
      let cyclesN = -1;
      try { faninN = (db.prepare(`SELECT COUNT(*) AS n FROM fanin`).get() as { n: number }).n; } catch { faninN = -1; }
      try { metricsN = (db.prepare(`SELECT COUNT(*) AS n FROM node_metrics`).get() as { n: number }).n; } catch { metricsN = -1; }
      try { cyclesN = (db.prepare(`SELECT COUNT(*) AS n FROM cycles`).get() as { n: number }).n; } catch { cyclesN = -1; }
      const fmtCache = (n: number): string => (n < 0 ? "n/a" : n > 0 ? `hit (${n} rows)` : "cold (0 rows)");
      console.log(`Cache: fanin ${fmtCache(faninN)}, node_metrics ${fmtCache(metricsN)}, cycles ${fmtCache(cyclesN)}`);
    } catch {
      // tabel cache tak tersedia — lewati
    }
    try {
      const commits = (db.prepare(`SELECT COUNT(*) AS n FROM commits`).get() as { n: number }).n;
      if (commits > 0) console.log(`History: ${commits} commits`);
    } catch {
      // pre-history DB
    }
    try {
      const verified = (db.prepare(`SELECT COUNT(*) AS n FROM verified_tasks`).get() as { n: number }).n;
      if (verified > 0) console.log(`Verified tasks: ${verified}`);
    } catch {
      // pre-learning DB
    }
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
