import fs from "node:fs";
import path from "node:path";
import type {
  AdapterContext,
  AdapterFile,
  AdapterResult,
  FrameworkAdapter,
} from "./types.js";
import { ensureAdapterSymbol, fileSymbolOf, insertRelation } from "./types.js";
import { withSyntaxTree } from "../treesitter.js";
import type { Node } from "web-tree-sitter";

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
  return withSyntaxTree("python", content, (root) => {
    const out: FastApiRoute[] = [];
    const visit = (node: Node) => {
      if (node.type === "decorated_definition") {
        const definition = node.childForFieldName("definition");
        const handler = definition?.type === "function_definition" ? definition.childForFieldName("name")?.text ?? null : null;
        if (handler) for (const decorator of node.namedChildren.filter((child): child is Node => child?.type === "decorator")) {
          const call = decorator.namedChildren.find((child) => child?.type === "call");
          const callee = call?.childForFieldName("function");
          const receiver = callee?.childForFieldName("object");
          const method = callee?.childForFieldName("attribute")?.text;
          const first = call?.childForFieldName("arguments")?.namedChildren[0];
          if (callee?.type === "attribute" && receiver?.type === "identifier" && method && METHODS.includes(method) &&
              first?.type === "string" && first.text.length > 2 && !first.namedChildren.some((child) => child?.type === "interpolation")) {
            out.push({ method: method.toUpperCase(), path: first.text.slice(1, -1), handler, line: decorator.startPosition.row + 1 });
          }
        }
      }
      for (const child of node.namedChildren) if (child) visit(child);
    };
    visit(root);
    return out;
  });
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
