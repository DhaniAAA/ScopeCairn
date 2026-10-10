import fs from "node:fs";
import path from "node:path";
import type {
  AdapterContext,
  AdapterFile,
  AdapterResult,
  FrameworkAdapter,
} from "./types.js";
import { ensureAdapterSymbol, fileSymbolOf, insertRelation } from "./types.js";

export interface DjangoRoute {
  path: string;
  handler: string;
  line: number;
}

export interface DjangoModel {
  name: string;
  line: number;
}

export function parseDjangoRoutes(content: string): DjangoRoute[] {
  const routes: DjangoRoute[] = [];
  // Cocokkan path('pattern/', view_func, ...) atau re_path(r'^pattern/', view_func, ...)
  const routeRegex = /(?:path|re_path)\s*\(\s*(?:r?['"`]([^'"`]*)['"`])\s*,\s*([a-zA-Z0-9_.]+)/g;
  let match: RegExpExecArray | null;
  while ((match = routeRegex.exec(content)) !== null) {
    let routePath = match[1];
    if (!routePath.startsWith("/")) routePath = "/" + routePath;
    const handler = match[2];
    const line = content.slice(0, match.index).split("\n").length;
    routes.push({
      path: routePath,
      handler,
      line,
    });
  }
  return routes;
}

export function parseDjangoModels(content: string): DjangoModel[] {
  const models: DjangoModel[] = [];
  // Cocokkan class ModelName(models.Model):
  const modelRegex = /class\s+([a-zA-Z0-9_]+)\s*\(\s*(?:models\.)?Model\s*\):/g;
  let match: RegExpExecArray | null;
  while ((match = modelRegex.exec(content)) !== null) {
    const name = match[1];
    const line = content.slice(0, match.index).split("\n").length;
    models.push({ name, line });
  }
  return models;
}

export const djangoAdapter: FrameworkAdapter = {
  id: "django",
  label: "Django",
  detect: (files) =>
    files.some(
      (f) =>
        f.endsWith("manage.py") ||
        f.endsWith("wsgi.py") ||
        f.endsWith("asgi.py") ||
        f.endsWith("urls.py")
    ),
  confirm: (repoRoot) => {
    if (fs.existsSync(path.join(repoRoot, "manage.py"))) return true;
    try {
      const dir = fs.readdirSync(repoRoot);
      for (const f of dir) {
        if (/^requirements.*\.txt$/.test(f) || f === "pyproject.toml") {
          const c = fs.readFileSync(path.join(repoRoot, f), "utf8");
          if (c.toLowerCase().includes("django")) return true;
        }
      }
    } catch {
      // skip
    }
    return false;
  },
  relevant: (rel) => rel.endsWith(".py"),
  apply(ctx: AdapterContext, files: AdapterFile[]): AdapterResult {
    let symbols = 0;
    let relations = 0;

    for (const f of files) {
      const fileSym = fileSymbolOf(ctx.db, f.fileId);
      if (!fileSym) continue;

      // Cek urls
      if (f.rel.endsWith("urls.py") || f.content.includes("urlpatterns")) {
        const routes = parseDjangoRoutes(f.content);
        for (const r of routes) {
          const routeName = `ROUTE ${r.path}`;
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

          // Handler function bisa berupa `views.my_view` atau `my_view`
          const handlerName = r.handler.split(".").pop();
          if (handlerName) {
            const sym = ctx.db
              .prepare(`SELECT id FROM symbols WHERE name = ? LIMIT 1`)
              .get(handlerName) as { id: number } | undefined;
            if (sym) {
              insertRelation(ctx.db, sym.id, routeId, "ROUTES_TO", 0.9, 1.0);
              relations++;
            }
          }
        }
      }

      // Cek models
      if (f.rel.endsWith("models.py") || f.content.includes("models.Model")) {
        const models = parseDjangoModels(f.content);
        for (const m of models) {
          const modelId = ensureAdapterSymbol(ctx.db, f.fileId, {
            name: m.name,
            type: "model",
            signature: `class ${m.name}(models.Model)`,
            startLine: m.line,
            endLine: m.line,
          });
          symbols++;

          insertRelation(ctx.db, fileSym, modelId, "MODELS", 1.0, 1.0);
          relations++;
        }
      }
    }

    return { symbols, relations };
  },
};
