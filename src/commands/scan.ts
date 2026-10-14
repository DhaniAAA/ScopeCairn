import fs from "node:fs";
import { dataDir } from "../db.js";
import { scanRepository } from "../scanner.js";
import { cmdWatch } from "./watch.js";

export interface ScanOptions {
  rebuild?: boolean;
  clean?: boolean;
  watch?: boolean;
  debounce?: number;
}

export async function cmdScan(repoRoot: string, opts: ScanOptions = {}): Promise<void> {
  const dir = dataDir(repoRoot);

  if (opts.clean) {
    fs.rmSync(dir, { recursive: true, force: true });
    console.log(`Cleaned ${dir}. Removed .scopecairn/. Run \`scopecairn scan\` to rebuild.`);
    return;
  }

  if (opts.watch) {
    await cmdWatch(repoRoot, { debounce: opts.debounce });
    return;
  }

  if (opts.rebuild) {
    fs.rmSync(dir, { recursive: true, force: true });
    console.log(`Cleaned ${dir}`);
  }

  console.log("ScopeCairn");
  console.log("✓ Repository detected");
  const stats = await scanRepository(repoRoot);
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
