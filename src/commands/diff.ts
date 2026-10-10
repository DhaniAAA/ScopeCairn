import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { openDb } from "../db.js";
import { changedFilesVsHead } from "../retrieval/gitChanged.js";
import { extractFile } from "../extract/index.js";
import { grammarForPath } from "../extract/treeSitter.js";
import { prepareTreeSitter } from "../treesitter.js";

export interface SymbolDiffItem {
  name: string;
  type: string;
  signature?: string;
  callers?: string[];
}

export interface FileStructuralDiff {
  path: string;
  status: "added" | "deleted" | "modified";
  addedSymbols: SymbolDiffItem[];
  removedSymbols: SymbolDiffItem[];
  modifiedSymbols: SymbolDiffItem[];
}

export interface StructuralDiffResult {
  totalChanged: number;
  files: FileStructuralDiff[];
  breakingWarnings: { symbol: string; file: string; affectedCallers: string[] }[];
}

function getGitFileAtHead(repoRoot: string, relPath: string): string | null {
  try {
    return execFileSync("git", ["show", `HEAD:${relPath.replace(/\\/g, "/")}`], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return null;
  }
}

export async function computeStructuralDiff(
  repoRoot: string
): Promise<StructuralDiffResult> {
  const changed = changedFilesVsHead(repoRoot).map((p) => p.replace(/\\/g, "/"));
  if (changed.length === 0) {
    return { totalChanged: 0, files: [], breakingWarnings: [] };
  }

  const grammars = changed
    .map(grammarForPath)
    .filter((x): x is string => Boolean(x));
  await prepareTreeSitter(grammars.length > 0 ? grammars : ["typescript", "javascript"]);

  let db: ReturnType<typeof openDb> | null = null;
  try {
    db = openDb(repoRoot);
  } catch {
    db = null;
  }

  const findCallers = (symbolName: string): string[] => {
    if (!db) return [];
    try {
      const rows = db
        .prepare(
          `SELECT s.name AS caller, f.path AS file
           FROM relationships r
           JOIN symbols target ON target.id = r.target_id
           JOIN symbols s ON s.id = r.source_id
           JOIN files f ON f.id = s.file_id
           WHERE target.name = ?
           LIMIT 10`
        )
        .all(symbolName) as { caller: string; file: string }[];
      return rows.map((r) => `${r.caller} (${r.file})`);
    } catch {
      return [];
    }
  };

  const fileDiffs: FileStructuralDiff[] = [];
  const breakingWarnings: StructuralDiffResult["breakingWarnings"] = [];

  for (const rel of changed) {
    const absPath = path.join(repoRoot, ...rel.split("/"));
    const headContent = getGitFileAtHead(repoRoot, rel);
    const diskExists = fs.existsSync(absPath);

    let status: FileStructuralDiff["status"] = "modified";
    if (headContent === null && diskExists) {
      status = "added";
    } else if (headContent !== null && !diskExists) {
      status = "deleted";
    }

    let currentContent = "";
    if (diskExists) {
      try {
        currentContent = fs.readFileSync(absPath, "utf8");
      } catch {
        currentContent = "";
      }
    }

    // Ekstraksi simbol versi lama vs versi baru
    const prevExtraction = headContent !== null ? extractFile(rel, headContent) : null;
    const currExtraction = diskExists ? extractFile(rel, currentContent) : null;

    const prevSymbols = prevExtraction ? prevExtraction.symbols : [];
    const currSymbols = currExtraction ? currExtraction.symbols : [];

    const prevMap = new Map<string, typeof prevSymbols[0]>();
    for (const s of prevSymbols) {
      prevMap.set(`${s.type}:${s.name}`, s);
    }

    const currMap = new Map<string, typeof currSymbols[0]>();
    for (const s of currSymbols) {
      currMap.set(`${s.type}:${s.name}`, s);
    }

    const addedSymbols: SymbolDiffItem[] = [];
    const removedSymbols: SymbolDiffItem[] = [];
    const modifiedSymbols: SymbolDiffItem[] = [];

    // Cek simbol baru
    for (const [key, s] of currMap.entries()) {
      if (!prevMap.has(key)) {
        addedSymbols.push({ name: s.name, type: s.type, signature: s.signature });
      }
    }

    // Cek simbol dihapus & dimodifikasi
    for (const [key, s] of prevMap.entries()) {
      const curr = currMap.get(key);
      if (!curr) {
        const callers = findCallers(s.name);
        removedSymbols.push({ name: s.name, type: s.type, signature: s.signature, callers });
        if (callers.length > 0) {
          breakingWarnings.push({ symbol: s.name, file: rel, affectedCallers: callers });
        }
      } else {
        // Cek modifikasi signature atau baris
        if (
          curr.signature !== s.signature ||
          Math.abs((curr.endLine - curr.startLine) - (s.endLine - s.startLine)) > 3
        ) {
          const callers = findCallers(s.name);
          modifiedSymbols.push({ name: s.name, type: s.type, signature: curr.signature, callers });
        }
      }
    }

    if (
      status !== "modified" ||
      addedSymbols.length > 0 ||
      removedSymbols.length > 0 ||
      modifiedSymbols.length > 0
    ) {
      fileDiffs.push({
        path: rel,
        status,
        addedSymbols,
        removedSymbols,
        modifiedSymbols,
      });
    }
  }

  if (db) {
    try {
      db.close();
    } catch {
      // ignore
    }
  }

  return {
    totalChanged: changed.length,
    files: fileDiffs,
    breakingWarnings,
  };
}

export async function cmdDiff(
  repoRoot: string,
  opts?: { json?: boolean }
): Promise<void> {
  const result = await computeStructuralDiff(repoRoot);

  if (opts?.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (result.totalChanged === 0) {
    console.log("No changes detected in working tree vs HEAD.");
    return;
  }

  console.log(`# ScopeCairn Structural Symbol Diff (${result.files.length} modified files analyzed)\n`);

  for (const f of result.files) {
    const statusLabel =
      f.status === "added" ? "[A]" : f.status === "deleted" ? "[D]" : "[M]";
    console.log(`${statusLabel} ${f.path}`);

    if (f.addedSymbols.length > 0) {
      for (const s of f.addedSymbols) {
        console.log(`    + [${s.type}] ${s.name}${s.signature ? ` (${s.signature})` : ""}`);
      }
    }
    if (f.modifiedSymbols.length > 0) {
      for (const s of f.modifiedSymbols) {
        console.log(`    ~ [${s.type}] ${s.name}${s.signature ? ` (${s.signature})` : ""}`);
      }
    }
    if (f.removedSymbols.length > 0) {
      for (const s of f.removedSymbols) {
        console.log(`    - [${s.type}] ${s.name}`);
      }
    }
    console.log("");
  }

  if (result.breakingWarnings.length > 0) {
    console.log("⚠️  POTENTIAL BREAKING CHANGES:");
    for (const w of result.breakingWarnings) {
      console.log(`  • Removed '${w.symbol}' in ${w.file}`);
      console.log(`    Referenced by: ${w.affectedCallers.slice(0, 3).join(", ")}${w.affectedCallers.length > 3 ? "..." : ""}`);
    }
    console.log("");
  }
}
