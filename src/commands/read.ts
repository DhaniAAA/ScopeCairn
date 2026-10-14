import fs from "node:fs";
import path from "node:path";
import { openDb } from "../db.js";
import { logInvocation } from "../invocations.js";
import { findSymbols } from "../graph.js";

// Symbol-level read (PRD §14): return the symbol's source excerpt,
// not the whole file.
export function cmdRead(repoRoot: string, kind: string, name: string, opts: { json?: boolean } = {}): void {
  if (kind !== "symbol") {
    const msg = `Unknown read kind "${kind}". Usage: scopecairn read symbol <nama>`;
    if (opts.json) console.log(JSON.stringify({ kind, name, error: msg }, null, 2));
    else console.log(msg);
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
      if (opts.json) console.log(JSON.stringify({ kind, name, error: `No symbol matching "${name}".` }, null, 2));
      else console.log(`No symbol matching "${name}".`);
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
    // Excerpt window: mulai dari baris definisi (1-based), def line s/d +40.
    // Sertakan blok komentar/docstring yang langsung menempel di atas
    // (AST-aware chunking: potongan selaras dengan simbol Tree-sitter).
    let start = row.start_line;
    while (start > 1 && start > row.start_line - 40) {
      const above = lines[start - 2]?.trim() ?? "";
      if (
        above.startsWith("//") || above.startsWith("/*") || above.startsWith("*") ||
        above.startsWith("#") || above.startsWith('"""') || above.startsWith("'''") ||
        above.startsWith("<!--")
      ) {
        start--;
      } else {
        break;
      }
    }
    const end = Math.min(lines.length, Math.max(row.end_line, row.start_line + 40));
    const excerpt = lines.slice(start - 1, end).join("\n");
    if (opts.json) {
      console.log(JSON.stringify({ name: node.name, type: node.type, file: node.file, range: `${start}-${end}`, excerpt }, null, 2));
      return;
    }
    console.log(`# ${node.name} (${node.type}) — ${node.file}:${start}-${end}`);
    console.log(excerpt);
  } finally {
    db.close();
  }
}
