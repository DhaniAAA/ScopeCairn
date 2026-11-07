import fs from "node:fs";
import path from "node:path";
import type {
  AdapterContext,
  AdapterFile,
  AdapterResult,
  FrameworkAdapter,
} from "./types.js";
import { ensureAdapterSymbol, fileSymbolOf, insertRelation } from "./types.js";

// Adapter Laravel: `routes/web.php` / `routes/api.php` —
//   Route::get('/users', [UserController::class, 'index']);
//   Route::post('/login', 'AuthController@login');
//   Route::get('/home', function () { ... });
// menjadi simbol `route`. Pola mengikuti django.ts (regex).

export interface LaravelRoute {
  method: string;
  path: string;
  handler: string | null;
  line: number;
}

const ROUTE_RE =
  /\bRoute::(get|post|put|patch|delete|any|match|options|head)\s*\(\s*(['"`])([^'"`]+)\2\s*(?:,\s*([\s\S]*?))?\)/g;

export function parseLaravelRoutes(content: string): LaravelRoute[] {
  const out: LaravelRoute[] = [];
  let m: RegExpExecArray | null;
  ROUTE_RE.lastIndex = 0;
  while ((m = ROUTE_RE.exec(content)) !== null) {
    const verb = m[1];
    const rawPath = m[3];
    const rest = (m[4] ?? "").trim();
    const method = verb === "any" || verb === "match" ? "ANY" : verb.toUpperCase();
    const routePath = rawPath.startsWith("/") ? rawPath : "/" + rawPath;
    let handler: string | null = null;
    // [UserController::class, 'index']
    const arr = /\[\s*([A-Za-z0-9_\\]+)::class\s*,\s*(['"`])([^'"`]+)\2\s*\]/.exec(rest);
    if (arr) {
      handler = arr[3];
    } else {
      // 'AuthController@index' atau "AuthController@index"
      const str = /^(['"`])([A-Za-z0-9_\\@]+)\1/.exec(rest);
      if (str) {
        handler = str[2].split("@").pop() ?? str[2];
      } else if (/^function/.test(rest)) {
        handler = null;
      } else {
        const ident = /^([A-Za-z0-9_$]+)/.exec(rest);
        if (ident) handler = ident[1];
      }
    }
    const line = content.slice(0, m.index).split("\n").length;
    out.push({ method, path: routePath, handler, line });
  }
  return out;
}

export const laravelAdapter: FrameworkAdapter = {
  id: "laravel",
  label: "Laravel",
  detect: (files) =>
    files.some(
      (f) =>
        f.endsWith(".php") ||
        /(^|\/)routes\/(web|api)\.php$/.test(f)
    ),
  confirm: (repoRoot) => {
    try {
      const composer = fs.readFileSync(path.join(repoRoot, "composer.json"), "utf8");
      if (composer.includes("laravel/framework")) return true;
    } catch {
      // tidak ada composer.json — lanjut
    }
    if (
      fs.existsSync(path.join(repoRoot, "routes", "web.php")) ||
      fs.existsSync(path.join(repoRoot, "routes", "api.php"))
    ) {
      return true;
    }
    return false;
  },
  relevant: (rel) => rel.endsWith(".php"),
  apply(ctx: AdapterContext, files: AdapterFile[]): AdapterResult {
    let symbols = 0;
    let relations = 0;
    for (const f of files) {
      if (!f.content.includes("Route::")) continue;
      const fileSym = fileSymbolOf(ctx.db, f.fileId);
      if (!fileSym) continue;
      for (const r of parseLaravelRoutes(f.content)) {
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
