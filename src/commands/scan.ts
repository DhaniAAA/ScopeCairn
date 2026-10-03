import { scanRepository } from "../scanner.js";

export function cmdScan(repoRoot: string): void {
  console.log("ScopeCairn");
  console.log("✓ Repository detected");
  const stats = scanRepository(repoRoot);
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
  console.log(
    `✓ index: +${stats.inserted} new, ~${stats.updated} updated, =${stats.unchanged} unchanged, -${stats.removed} removed`
  );
  console.log(`✓ ${(stats.durationMs / 1000).toFixed(2)}s`);
  console.log("Ready.");
}
