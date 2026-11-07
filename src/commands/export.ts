import fs from "node:fs";
import path from "node:path";
import { openDb, dataDir } from "../db.js";
import { logInvocation } from "../invocations.js";
import { exportGraph, type ExportFormat } from "../graph/export.js";

// Graphify Engine — Fitur 5: `scopecairn export --format <mermaid|graphml|dot|json>`.
const FORMATS: ExportFormat[] = ["mermaid", "graphml", "dot", "json"];

const EXT: Record<ExportFormat, string> = {
  mermaid: "mmd",
  graphml: "graphml",
  dot: "dot",
  json: "json",
};

export function cmdExport(
  repoRoot: string,
  format: string,
  out?: string,
  budget?: number
): void {
  const fmt = format.toLowerCase() as ExportFormat;
  if (!FORMATS.includes(fmt)) {
    console.log(`Unknown format "${format}". Choose: ${FORMATS.join(", ")}.`);
    return;
  }
  const db = openDb(repoRoot);
  try {
    logInvocation(db, "export");
    // Fase 4.3: no index → exit 1 (samakan doctor: set exitCode, jangan exit()).
    const fileCount = (
      db.prepare(`SELECT COUNT(*) AS n FROM files`).get() as { n: number }
    ).n;
    if (fileCount === 0) {
      console.log("Index kosong. Jalankan `scopecairn scan` dulu.");
      process.exitCode = 1;
      return;
    }
    // Fase 4.5: budget diteruskan ke exportGraph (node cap; default 500).
    const text = exportGraph(db, fmt, budget);
    const dest = out ?? path.join(dataDir(repoRoot), `graph.${EXT[fmt]}`);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, text);
    console.log(`Exported ${fmt} → ${dest}`);
  } finally {
    db.close();
  }
}
