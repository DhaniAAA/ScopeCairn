import fs from "node:fs";
import path from "node:path";
import { openDb } from "../db.js";
import { logInvocation, recordInvocationSavings } from "../invocations.js";
import { findSymbols, type GraphNode } from "../graph.js";

export interface ReadOptions {
  json?: boolean;
  /** `--full`: kembalikan SELURUH file, bukan excerpt ±40 baris. */
  full?: boolean;
  /** `--with-callers`: sertakan daftar simbol yang memanggil simbol ini (incoming). */
  withCallers?: boolean;
}

interface CallersResult {
  callers: { name: string; type: string; file: string }[];
}

interface ReadEntry {
  name: string;
  type: string;
  file: string;
  range: string;
  excerpt: string;
  callers?: { name: string; type: string; file: string }[];
}

interface ReadError {
  kind: string;
  name: string;
  error: string;
}

// Symbol-level read (PRD §14): return the symbol's source excerpt,
// not the whole file. Fase 4.2: terima banyak nama (`read symbol a b c`)
// sebagai wrapper atas per-symbol read satu per satu.
export function cmdRead(
  repoRoot: string,
  kind: string,
  name: string | string[],
  opts: ReadOptions = {}
): void {
  const names = Array.isArray(name) ? [...name] : [name];
  const multi = names.length > 1;

  if (kind !== "symbol") {
    const msg = `Unknown read kind "${kind}". Usage: scopecairn read symbol <nama>`;
    if (opts.json) {
      if (multi) {
        const arr = names.map((n) => ({ kind, name: n, error: msg }));
        console.log(JSON.stringify(arr, null, 2));
      } else {
        console.log(
          JSON.stringify({ kind, name: names[0] ?? name, error: msg }, null, 2)
        );
      }
    } else {
      console.log(msg);
    }
    return;
  }

  if (names.length === 0) {
    const msg = `Usage: scopecairn read symbol <nama> [nama2 ...]`;
    if (opts.json) console.log(JSON.stringify({ kind, error: msg }, null, 2));
    else console.log(msg);
    return;
  }

  const db = openDb(repoRoot);
  try {
    const invId = logInvocation(db, "read");
    const fileFullBytes = new Map<string, number>();
    let returnedBytes = 0;
    const trackEntry = (entry: (ReadEntry & { fullFileBytes?: number }) | ReadError): void => {
      if ("error" in entry) return;
      if (entry.fullFileBytes && !fileFullBytes.has(entry.file)) {
        fileFullBytes.set(entry.file, entry.fullFileBytes);
      }
      returnedBytes += Buffer.byteLength(entry.excerpt, "utf8");
    };
    const flushSavings = (): void => {
      let totalFull = 0;
      for (const b of fileFullBytes.values()) totalFull += b;
      recordInvocationSavings(db, invId, totalFull, returnedBytes);
    };

    if (opts.json) {
      if (multi) {
        const entries = names.map((n) => readOne(db, repoRoot, n, opts));
        for (const e of entries) trackEntry(e);
        flushSavings();
        const out = entries.map((e) =>
          "error" in e ? e : { name: e.name, type: e.type, file: e.file, range: e.range, excerpt: e.excerpt, ...(e.callers ? { callers: e.callers } : {}) }
        );
        console.log(JSON.stringify(out, null, 2));
      } else {
        const entry = readOne(db, repoRoot, names[0]!, opts);
        trackEntry(entry);
        flushSavings();
        // Pertahankan bentuk tunggal lama: error berisi {kind,name,error},
        // sukses berisi {name,type,file,range,excerpt[,callers]}.
        if ("error" in entry) {
          console.log(
            JSON.stringify({ kind, name: names[0]!, error: entry.error }, null, 2)
          );
        } else {
          const clean: ReadEntry = {
            name: entry.name,
            type: entry.type,
            file: entry.file,
            range: entry.range,
            excerpt: entry.excerpt,
            ...(entry.callers ? { callers: entry.callers } : {}),
          };
          console.log(JSON.stringify(clean, null, 2));
        }
      }
      return;
    }
    names.forEach((n, i) => {
      if (i > 0) console.log("");
      const entry = readOne(db, repoRoot, n, opts);
      trackEntry(entry);
      if ("error" in entry) {
        console.log(entry.error);
        return;
      }
      console.log(`# ${entry.name} (${entry.type}) — ${entry.file}:${entry.range}`);
      console.log(entry.excerpt);
      if (opts.withCallers) {
        const callers = entry.callers ?? [];
        console.log(`Callers (${callers.length}):`);
        if (callers.length === 0) console.log("  (none)");
        for (const c of callers) console.log(`  ${c.name} (${c.type}, ${c.file})`);
      }
    });
    flushSavings();
  } finally {
    db.close();
  }
}

/** Satu simbol: excerpt (atau full file), opsional callers. */
function readOne(
  db: ReturnType<typeof openDb>,
  repoRoot: string,
  name: string,
  opts: ReadOptions
): (ReadEntry & { fullFileBytes?: number }) | ReadError {
  const hits = findSymbols(db, name);
  const node: GraphNode | undefined =
    hits.find((h) => h.name === name && h.type !== "file") ??
    hits.find((h) => h.type !== "file") ??
    hits[0];
  if (!node) {
    return { kind: "symbol", name, error: `No symbol matching "${name}".` };
  }
  const abs = path.join(repoRoot, node.file);
  let rawFile: string;
  let lines: string[];
  try {
    rawFile = fs.readFileSync(abs, "utf8");
    lines = rawFile.split("\n");
  } catch {
    // Pesan error disamakan dengan jalur symbol-not-found agar multi-symbol
    // tetap bisa dilanjutkan; bentuk teks tunggal lama ikut cocok.
    return { kind: "symbol", name, error: `Cannot read ${node.file}.` };
  }
  const fullFileBytes = Buffer.byteLength(rawFile, "utf8");
  const row = db
    .prepare(`SELECT start_line, end_line FROM symbols WHERE id = ?`)
    .get(node.id) as { start_line: number; end_line: number };

  let start: number;
  let end: number;
  let excerpt: string;
  if (opts.full === true) {
    start = 1;
    end = lines.length;
    excerpt = lines.join("\n");
  } else {
    // Excerpt window: mulai dari baris definisi (1-based), def line s/d +40.
    // Sertakan blok komentar/docstring yang langsung menempel di atas
    // (AST-aware chunking: potongan selaras dengan simbol Tree-sitter).
    start = row.start_line;
    while (start > 1 && start > row.start_line - 40) {
      const above = lines[start - 2]?.trim() ?? "";
      if (
        above.startsWith("//") ||
        above.startsWith("/*") ||
        above.startsWith("*") ||
        above.startsWith("#") ||
        above.startsWith('"""') ||
        above.startsWith("'''") ||
        above.startsWith("<!--")
      ) {
        start--;
      } else {
        break;
      }
    }
    end = Math.min(lines.length, Math.max(row.end_line, row.start_line + 40));
    excerpt = lines.slice(start - 1, end).join("\n");
  }

  const entry: ReadEntry & { fullFileBytes?: number } = {
    name: node.name,
    type: node.type,
    file: node.file,
    range: `${start}-${end}`,
    excerpt,
    fullFileBytes,
  };
  if (opts.withCallers === true) {
    entry.callers = readCallers(db, node.id);
  }
  return entry;
}

function readCallers(
  db: ReturnType<typeof openDb>,
  nodeId: number
): CallersResult["callers"] {
  try {
    const rows = db
      .prepare(
        `SELECT s.name AS name, s.type AS type, f.path AS file
         FROM relationships r
         JOIN symbols s ON s.id = r.source_id
         JOIN files f ON f.id = s.file_id
         WHERE r.target_id = ? LIMIT 20`
      )
      .all(nodeId) as { name: string; type: string; file: string }[];
    return rows.map((r) => ({ name: r.name, type: r.type, file: r.file }));
  } catch {
    return [];
  }
}
