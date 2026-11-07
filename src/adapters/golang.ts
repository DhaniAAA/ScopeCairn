import fs from "node:fs";
import path from "node:path";
import type {
  AdapterContext,
  AdapterFile,
  AdapterResult,
  FrameworkAdapter,
} from "./types.js";
import { ensureAdapterSymbol, fileSymbolOf, insertRelation } from "./types.js";

// Adapter Go: `net/http` (`http.HandleFunc("/x", h)`), `gin`
// (`r.GET("/x", h)` / `router.POST(...)`), `fiber`/`chi`
// (`app.Get(...)`), `gorilla/mux` (`r.HandleFunc(...)`).
// Pola regex generik `*.GET|*.POST|...|*.HandleFunc(...)`.
// Mengikuti pola django.ts (regex, bukan tree-sitter).

export interface GolangRoute {
  method: string;
  path: string;
  handler: string | null;
  line: number;
}

const VERBS = ["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"];

export function parseGolangRoutes(content: string): GolangRoute[] {
  const out: GolangRoute[] = [];
  // 1. http.HandleFunc("/path", handler) / mux.HandleFunc(...)
  const handleRe =
    /\b(?:http|mux|router|muxRouter)\s*\.\s*(?:HandleFunc|Handle)\s*\(\s*(['"`])([^'"`]+)\1\s*(?:,\s*([a-zA-Z0-9_.()]+))?/g;
  let m: RegExpExecArray | null;
  while ((m = handleRe.exec(content)) !== null) {
    const routePath = m[2].startsWith("/") ? m[2] : "/" + m[2];
    const rawHandler = m[3] ?? null;
    const line = content.slice(0, m.index).split("\n").length;
    out.push({
      method: "GET",
      path: routePath,
      handler: rawHandler ? extractHandlerName(rawHandler) : null,
      line,
    });
  }
  // 2. r.GET("/path", h) / router.POST(...) / e.GET(...) / group.GET(...)
  //    dan fiber: app.Get("/path", h)
  const verbRe =
    /\b\w+\s*\.\s*(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS|Get|Post|Put|Delete|Patch|Head|Options)\s*\(\s*(['"`])([^'"`]+)\2\s*(?:,\s*([^\s),]+))?/g;
  while ((m = verbRe.exec(content)) !== null) {
    const verb = m[1].toUpperCase();
    const routePath = m[3].startsWith("/") ? m[3] : "/" + m[3];
    if (!VERBS.includes(verb)) continue;
    const rawHandler = m[4] ?? null;
    // Abaikan bila sudah tercatat dari HandleFunc (duplikat path+method).
    if (out.some((r) => r.method === verb && r.path === routePath)) continue;
    const line = content.slice(0, m.index).split("\n").length;
    out.push({
      method: verb,
      path: routePath,
      handler: rawHandler ? extractHandlerName(rawHandler) : null,
      line,
    });
  }
  return out;
}

function extractHandlerName(raw: string): string | null {
  const trimmed = raw.trim().replace(/[),;]+$/g, "").replace(/\(.*\)$/, "");
  const ident = /([a-zA-Z_][a-zA-Z0-9_]*)\s*$/.exec(trimmed);
  if (!ident) return null;
  const name = ident[1];
  if (name === "func" || trimmed.startsWith("func")) return null;
  return name;
}

function hasGolangMarker(content: string): boolean {
  return (
    content.includes("net/http") ||
    content.includes("gin-gonic") ||
    content.includes("gofiber") ||
    content.includes("go-chi") ||
    content.includes("gorilla/mux") ||
    /\.\s*(GET|POST|PUT|DELETE|PATCH|Get|Post|Put|Delete|HandleFunc|Handle)\s*\(/.test(content)
  );
}

export const golangAdapter: FrameworkAdapter = {
  id: "golang",
  label: "Go",
  detect: (files) => files.some((f) => f.endsWith(".go") || f.endsWith("go.mod")),
  confirm: (repoRoot) => {
    try {
      const gom = fs.readFileSync(path.join(repoRoot, "go.mod"), "utf8");
      return (
        gom.includes("gin-gonic/gin") ||
        gom.includes("gofiber/fiber") ||
        gom.includes("go-chi/chi") ||
        gom.includes("gorilla/mux") ||
        // net/http stdlib — cukup go.mod ada
        true
      );
    } catch {
      return false;
    }
  },
  relevant: (rel) => rel.endsWith(".go"),
  apply(ctx: AdapterContext, files: AdapterFile[]): AdapterResult {
    let symbols = 0;
    let relations = 0;
    for (const f of files) {
      if (!hasGolangMarker(f.content)) continue;
      const fileSym = fileSymbolOf(ctx.db, f.fileId);
      if (!fileSym) continue;
      for (const r of parseGolangRoutes(f.content)) {
        const routeName = `${r.method} ${r.path}`;
        const routeId = ensureAdapterSymbol(ctx.db, f.fileId, {
          name: routeName,
          type: "route",
          signature: routeName,
          startLine: r.line,
          endLine: r.line,
        });
        symbols++;
        insertRelation(ctx.db, fileSym, routeId, "CONTAINS", 1.0, 1.0);
        relations++;
        if (r.handler) {
          const sym = ctx.db
            .prepare(`SELECT id FROM symbols WHERE name = ? LIMIT 1`)
            .get(r.handler) as { id: number } | undefined;
          if (sym) {
            insertRelation(ctx.db, sym.id, routeId, "ROUTES_TO", 0.9, 1.0);
            relations++;
          }
        }
      }
    }
    return { symbols, relations };
  },
};
