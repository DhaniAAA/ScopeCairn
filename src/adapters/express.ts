import fs from "node:fs";
import path from "node:path";
import type {
  AdapterContext,
  AdapterFile,
  AdapterResult,
  FrameworkAdapter,
} from "./types.js";
import {
  enclosingFunction,
  ensureAdapterSymbol,
  fileSymbolOf,
  insertRelation,
} from "./types.js";
import { WEIGHT } from "../extract/types.js";
import { withSyntaxTree } from "../treesitter.js";
import { grammarForPath } from "../extract/treeSitter.js";
import type { Node } from "web-tree-sitter";

// Adapter Express: `app.get/post/put/delete/patch/use(path, handler)`
// (dan analog `router.*`) menjadi simbol `route` + edge file→handler.
// Batasan: handler inline (arrow/anon) tak punya simbol — hanya simbol route.

const METHODS = ["get", "post", "put", "delete", "patch", "use"];

export interface ExpressRoute {
  method: string;
  path: string;
  handler: string | null;
  line: number;
}

function expressRoutes(content: string, grammar: string): ExpressRoute[] {
  return withSyntaxTree(grammar, content, (root) => {
    const out: ExpressRoute[] = [];
    const visit = (node: Node) => {
      if (node.type === "call_expression") {
        const callee = node.childForFieldName("function");
        const receiver = callee?.childForFieldName("object");
        const method = callee?.childForFieldName("property")?.text;
        const args = node.childForFieldName("arguments")?.namedChildren ?? [];
        const path = args[0];
        if (callee?.type === "member_expression" && receiver?.type === "identifier" &&
            (receiver.text === "app" || receiver.text === "router") && method && METHODS.includes(method) &&
            (path?.type === "string" || path?.type === "template_string" && !path.namedChildren.some((child) => child?.type === "template_substitution")) &&
            path.text.length > 2 && args.length > 1) {
          out.push({
            method: method.toUpperCase(),
            path: path.text.slice(1, -1),
            handler: args[1]?.type === "identifier" ? args[1].text : null,
            line: node.startPosition.row + 1,
          });
        }
      }
      for (const child of node.namedChildren) if (child) visit(child);
    };
    visit(root);
    return out;
  });
}

export function parseExpressRoutes(content: string): ExpressRoute[] {
  return expressRoutes(content, "typescript");
}

function hasExpressMarker(content: string): boolean {
  return (
    content.includes("express") ||
    /\b(?:app|router)\s*\.\s*(get|post|put|delete|patch|use)\s*\(/.test(content)
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

export const expressAdapter: FrameworkAdapter = {
  id: "express",
  label: "Express",
  detect: (files) =>
    files.some(
      (f) =>
        f.endsWith("package.json") ||
        /\.(js|ts|mjs|cjs)$/.test(f)
    ),
  confirm: (repoRoot) => {
    try {
      const pkg = fs.readFileSync(path.join(repoRoot, "package.json"), "utf8");
      return pkg.includes('"express"') || pkg.includes("'express'");
    } catch {
      return false;
    }
  },
  relevant: (rel) => /\.(js|ts|mjs|cjs)$/.test(rel),
  apply(ctx: AdapterContext, files: AdapterFile[]): AdapterResult {
    let symbols = 0;
    let relations = 0;
    for (const f of files) {
      if (!hasExpressMarker(f.content)) continue;
      const fileSym = fileSymbolOf(ctx.db, f.fileId);
      if (!fileSym) continue;
      for (const r of expressRoutes(f.content, grammarForPath(f.rel) ?? "typescript")) {
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
            insertRelation(ctx.db, fileSym, handlerId, "USES", WEIGHT.USES, 0.9);
            relations++;
            const enclosing = enclosingFunction(ctx.db, f.fileId, r.line);
            if (enclosing && enclosing !== handlerId) {
              insertRelation(ctx.db, enclosing, handlerId, "CALLS", WEIGHT.CALLS, 0.7);
              relations++;
            }
          }
        }
      }
    }
    return { symbols, relations };
  },
};
