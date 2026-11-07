import fs from "node:fs";
import path from "node:path";
import type {
  AdapterContext,
  AdapterFile,
  AdapterResult,
  FrameworkAdapter,
} from "./types.js";
import { ensureAdapterSymbol, fileSymbolOf, insertRelation } from "./types.js";

// Adapter Rails: `config/routes.rb` —
//   get    "/users",    to: "users#index"
//   post   "/login",    to: "sessions#create"
// menjadi simbol `route` per baris. Juga `resources :photos`
// (menghasilkan 7 route REST standar) dan `root to: ...`.
// Pola mengikuti django.ts (regex, bukan tree-sitter).

export interface RailsRoute {
  method: string;
  path: string;
  handler: string | null;
  line: number;
}

const VERB_RE = /\b(get|post|put|patch|delete|head|root)\s+(['"`])([^'"`]+)\2\s*,\s*to:\s*(['"`])([^'"`]+)\4/;
const VERB_RE2 = /\b(get|post|put|patch|delete|head)\s+(['"`])([^'"`]+)\2\s*,\s*to:\s*([a-zA-Z0-9_#.]+)/;
const RESOURCES_RE = /\bresources\s+:([a-zA-Z0-9_]+)/;

export function parseRailsRoutes(content: string): RailsRoute[] {
  const out: RailsRoute[] = [];
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const lineText = lines[i];
    const trimmed = lineText.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const line = i + 1;
    let m = VERB_RE.exec(lineText);
    if (m) {
      const verb = m[1];
      const p = m[3];
      const to = m[5];
      const method = verb === "root" ? "GET" : verb.toUpperCase();
      const routePath = verb === "root" ? "/" : p.startsWith("/") ? p : "/" + p;
      out.push({ method, path: routePath, handler: to, line });
      continue;
    }
    m = VERB_RE2.exec(lineText);
    if (m) {
      const verb = m[1];
      const p = m[3];
      const to = m[4];
      const routePath = p.startsWith("/") ? p : "/" + p;
      out.push({ method: verb.toUpperCase(), path: routePath, handler: to, line });
      continue;
    }
    const r = RESOURCES_RE.exec(lineText);
    if (r) {
      const name = r[1];
      const resourcesTemplates: [string, string, string][] = [
        ["GET", `/${name}`, "index"],
        ["GET", `/${name}/new`, "new"],
        ["POST", `/${name}`, "create"],
        ["GET", `/${name}/:id`, "show"],
        ["GET", `/${name}/:id/edit`, "edit"],
        ["PATCH", `/${name}/:id`, "update"],
        ["DELETE", `/${name}/:id`, "destroy"],
      ];
      for (const [verb, p, act] of resourcesTemplates) {
        out.push({ method: verb, path: p, handler: `${name}#${act}`, line });
      }
    }
  }
  return out;
}

function handlerShort(handler: string): string {
  // "users#index" -> "index"; "users#index" -> cari simbol index
  const part = handler.split("#").pop() ?? handler;
  return part.split(".").pop() ?? part;
}

export const railsAdapter: FrameworkAdapter = {
  id: "rails",
  label: "Rails",
  detect: (files) =>
    files.some((f) => f.endsWith("routes.rb") || f.endsWith(".rb")),
  confirm: (repoRoot) => {
    if (fs.existsSync(path.join(repoRoot, "config", "routes.rb"))) return true;
    try {
      const gemfile = fs.readFileSync(path.join(repoRoot, "Gemfile"), "utf8");
      if (gemfile.includes("rails")) return true;
    } catch {
      // tidak ada Gemfile — lanjut
    }
    try {
      const dir = fs.readdirSync(repoRoot);
      for (const f of dir) {
        if (/.*\.gemspec$/.test(f)) {
          try {
            const c = fs.readFileSync(path.join(repoRoot, f), "utf8");
            if (c.includes("rails")) return true;
          } catch {
            // skip
          }
        }
      }
    } catch {
      // skip
    }
    return false;
  },
  relevant: (rel) => rel.endsWith(".rb"),
  apply(ctx: AdapterContext, files: AdapterFile[]): AdapterResult {
    let symbols = 0;
    let relations = 0;
    for (const f of files) {
      const isRoutesFile =
        f.rel.endsWith("routes.rb") ||
        f.content.includes("Rails.application.routes") ||
        f.content.includes("to:");
      if (!isRoutesFile) continue;
      const fileSym = fileSymbolOf(ctx.db, f.fileId);
      if (!fileSym) continue;
      for (const r of parseRailsRoutes(f.content)) {
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
          const short = handlerShort(r.handler);
          const sym = ctx.db
            .prepare(`SELECT id FROM symbols WHERE name = ? LIMIT 1`)
            .get(short) as { id: number } | undefined;
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
