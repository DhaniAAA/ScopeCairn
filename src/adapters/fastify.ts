import fs from "node:fs";
import path from "node:path";
import type {
  AdapterContext,
  AdapterFile,
  AdapterResult,
  FrameworkAdapter,
} from "./types.js";
import { ensureAdapterSymbol, fileSymbolOf, insertRelation } from "./types.js";

// Adapter Fastify / Koa / Hono: `app.get("/path", handler)` (dan varian
// `router.*`, `server.*`, `fastify.*`) menjadi simbol `route`.
// Pola sama dengan express.ts; receiver diperluas agar mencakup
// Fastify (`fastify.get`), Koa (`router.get` via @koa/router),
// dan Hono (`app.get`). Batasan: handler inline tak punya simbol.

const METHODS = ["get", "post", "put", "delete", "patch", "all", "use", "route", "on"];
const RECEIVERS = ["app", "router", "server", "fastify", "fastifyServer"];

export interface FastifyRoute {
  method: string;
  path: string;
  handler: string | null;
  line: number;
}

export function parseFastifyRoutes(content: string): FastifyRoute[] {
  const out: FastifyRoute[] = [];
  const re = new RegExp(
    `\\b(?:${RECEIVERS.join("|")})\\s*\\.\\s*(${METHODS.join("|")})\\s*\\(\\s*(?:"([^"]+)"|'([^']+)'|` + "`" + `([^` + "`" + `]+)` + "`" + `)`,
    "g"
  );
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    const rawMethod = m[1];
    const rawPath = m[2] ?? m[3] ?? m[4] ?? "";
    if (!rawPath) continue;
    // Hono: app.on("GET", "/path", handler) — arg pertama adalah verb.
    let method = rawMethod.toUpperCase();
    let routePath = rawPath;
    let rest = content.slice(re.lastIndex);
    if (rawMethod === "on") {
      const second = /^\s*,\s*(?:"([^"]+)"|'([^']+)'|`([^`]+)`)/.exec(rest);
      if (!second) continue;
      method = rawPath.toUpperCase();
      routePath = second[1] ?? second[2] ?? second[3] ?? "";
      if (!routePath) continue;
      rest = rest.slice(second[0].length);
    }
    const handlerMatch = /^\s*,\s*([a-zA-Z0-9_$.]+)/.exec(rest);
    const line = content.slice(0, m.index).split("\n").length;
    out.push({
      method,
      path: routePath,
      handler: handlerMatch ? handlerMatch[1].split(".").pop() ?? handlerMatch[1] : null,
      line,
    });
  }
  return out;
}

function hasFastifyMarker(content: string): boolean {
  return (
    content.includes("fastify") ||
    content.includes("@koa/router") ||
    content.includes("hono") ||
    /\b(?:app|router|server|fastify)\s*\.\s*(get|post|put|delete|patch|all|use|route|on)\s*\(/.test(content)
  );
}

function findInFile(db: AdapterContext["db"], fileId: number, name: string): number | null {
  const row = db
    .prepare(`SELECT id FROM symbols WHERE file_id = ? AND name = ? LIMIT 1`)
    .get(fileId, name) as { id: number } | undefined;
  return row ? row.id : null;
}

export const fastifyAdapter: FrameworkAdapter = {
  id: "fastify",
  label: "Fastify",
  detect: (files) =>
    files.some((f) => f.endsWith("package.json") || /\.(js|ts|mjs|cjs)$/.test(f)),
  confirm: (repoRoot) => {
    try {
      const pkg = fs.readFileSync(path.join(repoRoot, "package.json"), "utf8");
      return (
        pkg.includes('"fastify"') ||
        pkg.includes("'fastify'") ||
        pkg.includes('"koa"') ||
        pkg.includes("'koa'") ||
        pkg.includes('"hono"') ||
        pkg.includes("'hono'")
      );
    } catch {
      return false;
    }
  },
  relevant: (rel) => /\.(js|ts|mjs|cjs)$/.test(rel),
  apply(ctx: AdapterContext, files: AdapterFile[]): AdapterResult {
    let symbols = 0;
    let relations = 0;
    for (const f of files) {
      if (!hasFastifyMarker(f.content)) continue;
      const fileSym = fileSymbolOf(ctx.db, f.fileId);
      if (!fileSym) continue;
      for (const r of parseFastifyRoutes(f.content)) {
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
