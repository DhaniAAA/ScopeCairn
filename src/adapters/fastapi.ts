import fs from "node:fs";
import path from "node:path";
import type {
  AdapterContext,
  AdapterFile,
  AdapterResult,
  FrameworkAdapter,
} from "./types.js";
import { ensureAdapterSymbol, fileSymbolOf, insertRelation, lineOf } from "./types.js";

// Adapter FastAPI: decorator `@app.get("/path")` / `@router.post(...)`
// menjadi simbol `route`, dengan edge file→handler function (`def` di
// bawah decorator). Batasan: decorator tanpa path literal dilewati.

const METHODS = ["get", "post", "put", "delete", "patch", "head", "options"];

export interface FastApiRoute {
  method: string;
  path: string;
  handler: string | null;
  line: number;
}

export function parseFastApiRoutes(content: string): FastApiRoute[] {
  const out: FastApiRoute[] = [];
  const re = new RegExp(
    `^\\s*@\\w+\\s*\\.\\s*(${METHODS.join("|")})\\s*\\(\\s*["']([^"']+)["']`,
    "gm"
  );
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    const window = content.slice(m.index, m.index + 400);
    const hm = /(?:async\s+)?def\s+(\w+)/.exec(window);
    out.push({
      method: m[1].toUpperCase(),
      path: m[2],
      handler: hm ? hm[1] : null,
      line: lineOf(content, m.index),
    });
  }
  return out;
}

function hasFastApiMarker(content: string): boolean {
  return (
    content.includes("fastapi") ||
    /^\s*@\w+\s*\.\s*(get|post|put|delete|patch|head|options)\s*\(/m.test(content)
  );
}

function findInFile(
  db: AdapterContext["db"],
  fileId: number,
  name: string
): number | null {
  const row = db
    .prepare(`SELECT id FROM symbols WHERE file_id = ? AND name = ? LIMIT 1`)
    .get(fileId, name) as { id: number } | undefined;
  return row ? row.id : null;
}

function readDepFile(repoRoot: string, names: string[]): string {
  let out = "";
  for (const n of names) {
    try {
      out += fs.readFileSync(path.join(repoRoot, n), "utf8");
    } catch {
      // tidak ada — lanjut
    }
  }
  try {
    const dir = fs.readdirSync(repoRoot);
    for (const f of dir) {
      if (/^requirements.*\.txt$/.test(f)) {
        try {
          out += fs.readFileSync(path.join(repoRoot, f), "utf8");
        } catch {
          // skip
        }
      }
    }
  } catch {
    // skip
  }
  return out;
}

export const fastapiAdapter: FrameworkAdapter = {
  id: "fastapi",
  label: "FastAPI",
  detect: (files) =>
    files.some(
      (f) =>
        /\.py$/.test(f) ||
        /(^|\/)requirements.*\.txt$/.test(f) ||
        /(^|\/)pyproject\.toml$/.test(f)
    ),
  confirm: (repoRoot) => {
    try {
      const pkg = fs.readFileSync(path.join(repoRoot, "package.json"), "utf8");
      if (pkg.includes('"fastapi"')) return true;
    } catch {
      // bukan repo node — lanjut
    }
    const deps = readDepFile(repoRoot, ["requirements.txt", "pyproject.toml"]);
    return deps.toLowerCase().includes("fastapi");
  },
  relevant: (rel) => /\.py$/.test(rel),
  apply(ctx: AdapterContext, files: AdapterFile[]): AdapterResult {
    let symbols = 0;
    let relations = 0;
    for (const f of files) {
      if (!hasFastApiMarker(f.content)) continue;
      const fileSym = fileSymbolOf(ctx.db, f.fileId);
      if (!fileSym) continue;
      for (const r of parseFastApiRoutes(f.content)) {
        const routeId = ensureAdapterSymbol(ctx.db, f.fileId, {
          name: `${r.method} ${r.path}`,
          type: "route",
          signature: `${r.method} ${r.path}`,
          startLine: r.line,
          endLine: r.line,
        });
        symbols++;
        insertRelation(ctx.db, fileSym, routeId, "CONTAINS", 1.0, 1.0);
        relations++;
        if (r.handler) {
          const handlerId = findInFile(ctx.db, f.fileId, r.handler);
          if (handlerId) {
            insertRelation(ctx.db, fileSym, handlerId, "USES", 0.5, 0.9);
            relations++;
            insertRelation(ctx.db, handlerId, routeId, "ROUTES_TO", 0.9, 1.0);
            relations++;
          }
        }
      }
    }
    return { symbols, relations };
  },
};
