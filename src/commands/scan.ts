import fs from "node:fs";
import { dataDir, openDb } from "../db.js";
import { scanRepository } from "../scanner.js";
import { logInvocation } from "../invocations.js";
import { cmdWatch } from "./watch.js";

export interface ScanOptions {
  rebuild?: boolean;
  clean?: boolean;
  watch?: boolean;
  debounce?: number;
  changedOnly?: boolean;
  lsp?: boolean;
  json?: boolean;
}

export async function cmdScan(repoRoot: string, opts: ScanOptions = {}): Promise<void> {
  const dir = dataDir(repoRoot);

  if (opts.clean) {
    fs.rmSync(dir, { recursive: true, force: true });
    if (opts.json) {
      console.log(JSON.stringify({ cleaned: true, dir }, null, 2));
    } else {
      console.log(`Cleaned ${dir}. Removed .scopecairn/. Run \`scopecairn scan\` to rebuild.`);
    }
    return;
  }

  if (opts.watch) {
    await cmdWatch(repoRoot, { debounce: opts.debounce });
    return;
  }

  if (opts.rebuild) {
    fs.rmSync(dir, { recursive: true, force: true });
    if (!opts.json) console.log(`Cleaned ${dir}`);
  }

  if (!opts.json) {
    console.log("ScopeCairn");
    console.log("✓ Repository detected");
  }
  const stats = await scanRepository(repoRoot, { changedOnly: opts.changedOnly === true, lsp: opts.lsp === true });
  // Compliance (AI-5): `scan` menutup loop prompt → context → kerja → refresh,
  // jadi ikut dicatat. Mode watch tidak lewat sini agar log tidak banjir.
  try {
    const db = openDb(repoRoot);
    try {
      logInvocation(db, "scan");
    } finally {
      db.close();
    }
  } catch {
    // pencatatan tak boleh menggagalkan scan
  }
  if (opts.json) {
    console.log(JSON.stringify(stats, null, 2));
    return;
  }
  console.log(`✓ ${stats.totalFilesSeen} files found (non-ignored)`);
  console.log(`✓ ${stats.sourceFiles} source files`);
  if (stats.metaFiles > 0) {
    console.log(`✓ ${stats.metaFiles} config/schema files (json/yml/sql/prisma, file-level)`);
  }
  console.log(`✓ ${stats.symbols} symbols`);
  console.log(`✓ ${stats.relationships} relationships`);
  if (stats.adapters.length > 0) {
    console.log(`✓ adapters: ${stats.adapters.join(", ")}`);
  }
  if (stats.lsp) {
    const found = [
      stats.lsp.tsserver ? "tsserver" : null,
      stats.lsp.gopls ? "gopls" : null,
      stats.lsp.pyright ? "pyright" : null,
      stats.lsp.rustAnalyzer ? "rust-analyzer" : null,
    ].filter(Boolean);
    const upgNote = stats.lspUpgraded ? `, upgraded ${stats.lspUpgraded} edge(s)` : "";
    console.log(
      `✓ lsp: ${found.length > 0 ? found.join(", ") : "none in PATH (opsional, scan tetap penuh)"}${upgNote}`
    );
  }
  if (stats.graphWritten) {
    console.log(`✓ GRAPH.md updated (.scopecairn/GRAPH.md)`);
  }
  if (stats.visualWritten) {
    console.log(`✓ GRAPH.html updated (.scopecairn/GRAPH.html — open in browser)`);
  }
  console.log(
    `✓ index: +${stats.inserted} new, ~${stats.updated} updated, =${stats.unchanged} unchanged, -${stats.removed} removed`
  );
  console.log(`✓ ${(stats.durationMs / 1000).toFixed(2)}s`);
  console.log("Ready.");
}
