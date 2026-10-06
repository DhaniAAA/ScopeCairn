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

export function cmdExport(repoRoot: string, format: string, out?: string): void {
  const fmt = format.toLowerCase() as ExportFormat;
  if (!FORMATS.includes(fmt)) {
    console.log(`Unknown format "${format}". Choose: ${FORMATS.join(", ")}.`);
    return;
  }
  const db = openDb(repoRoot);
  try {
    logInvocation(db, "export");
    const text = exportGraph(db, fmt);
    const dest = out ?? path.join(dataDir(repoRoot), `graph.${EXT[fmt]}`);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, text);
    console.log(`Exported ${fmt} → ${dest}`);
  } finally {
    db.close();
  }
}
