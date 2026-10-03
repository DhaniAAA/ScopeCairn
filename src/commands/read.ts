import fs from "node:fs";
import path from "node:path";
import { openDb } from "../db.js";
import { logInvocation } from "../invocations.js";
import { findSymbols } from "../graph.js";

// Symbol-level read (PRD §14): return the symbol's source excerpt,
// not the whole file.
export function cmdRead(repoRoot: string, kind: string, name: string): void {
  if (kind !== "symbol") {
    console.log(`Unknown read kind "${kind}". Usage: scopecairn read symbol <nama>`);
    return;
  }
  const db = openDb(repoRoot);
  try {
    logInvocation(db, "read");
    const hits = findSymbols(db, name);
    const node =
      hits.find((h) => h.name === name && h.type !== "file") ??
      hits.find((h) => h.type !== "file") ??
      hits[0];
    if (!node) {
      console.log(`No symbol matching "${name}".`);
      return;
    }
    const row = db
      .prepare(`SELECT start_line, end_line FROM symbols WHERE id = ?`)
      .get(node.id) as { start_line: number; end_line: number };
    const abs = path.join(repoRoot, node.file);
    let lines: string[];
    try {
      lines = fs.readFileSync(abs, "utf8").split("\n");
    } catch {
      console.log(`Cannot read ${node.file}.`);
      return;
    }
    // Excerpt window: def line ± context (def line + up to 40 lines).
    const start = Math.max(1, row.start_line - 1);
    const end = Math.min(lines.length, Math.max(row.end_line, row.start_line + 40));
    console.log(`# ${node.name} (${node.type}) — ${node.file}:${start}-${end}`);
    console.log(lines.slice(start - 1, end).join("\n"));
  } finally {
    db.close();
  }
}
