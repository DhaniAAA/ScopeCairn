import fs from "node:fs";
import path from "node:path";
import type {
  AdapterContext,
  AdapterFile,
  AdapterResult,
  FrameworkAdapter,
} from "./types.js";
import { ensureAdapterSymbol, fileSymbolOf, insertRelation, findSymbolId } from "./types.js";

// Adapter NestJS: Deteksi decorator @Controller('prefix'),
// @Get('path'), @Post('path'), @Put(), @Delete(), @Patch(), @Injectable().

const HTTP_METHODS = ["Get", "Post", "Put", "Delete", "Patch", "Options", "Head"];

export interface NestRoute {
  method: string;
  path: string;
  handler: string;
  line: number;
}

export function parseNestRoutes(content: string): NestRoute[] {
  const routes: NestRoute[] = [];

  // 1. Ekstrak prefix controller bila ada: @Controller('api/v1') atau @Controller()
  let controllerPrefix = "";
  const controllerMatch = content.match(/@Controller\s*\(\s*(?:['"`]([^'"`]*)['"`])?\s*\)/);
  if (controllerMatch && controllerMatch[1]) {
    controllerPrefix = controllerMatch[1].trim();
    if (controllerPrefix.startsWith("/")) controllerPrefix = controllerPrefix.slice(1);
    if (controllerPrefix.endsWith("/")) controllerPrefix = controllerPrefix.slice(0, -1);
  }

  // 2. Ekstrak decorator route method dan fungsi handler-nya
  // Contoh:
  // @Get(':id')
  // async findOne(...)
  const methodRegex = new RegExp(
    `@(${HTTP_METHODS.join("|")})\\s*\\(\\s*(?:['"\`]([^'"\`]*)['"\`])?\\s*\\)[\\s\\S]*?(?:async\\s+)?([a-zA-Z0-9_$]+)\\s*\\(`,
    "g"
  );

  let match: RegExpExecArray | null;
  while ((match = methodRegex.exec(content)) !== null) {
    const httpVerb = match[1].toUpperCase();
    let subPath = match[2] ? match[2].trim() : "";
    if (subPath.startsWith("/")) subPath = subPath.slice(1);

    const fullPath = "/" + [controllerPrefix, subPath].filter(Boolean).join("/");
    const handler = match[3];
    const line = content.slice(0, match.index).split("\n").length;

    routes.push({
      method: httpVerb,
      path: fullPath,
      handler,
      line,
    });
  }

  return routes;
}

export function parseNestInjectables(content: string): { name: string; line: number }[] {
  const injectables: { name: string; line: number }[] = [];
  const regex = /@Injectable\s*\(\s*\)[\s\S]*?class\s+([a-zA-Z0-9_$]+)/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(content)) !== null) {
    const name = match[1];
    const line = content.slice(0, match.index).split("\n").length;
    injectables.push({ name, line });
  }
  return injectables;
}

export const nestjsAdapter: FrameworkAdapter = {
  id: "nestjs",
  label: "NestJS",
  detect: (files) =>
    files.some(
      (f) =>
        f.endsWith(".controller.ts") ||
        f.endsWith(".service.ts") ||
        f.endsWith(".module.ts") ||
        f.endsWith("nest-cli.json")
    ),
  confirm: (repoRoot) => {
    try {
      const pkg = fs.readFileSync(path.join(repoRoot, "package.json"), "utf8");
      return pkg.includes("@nestjs/core") || pkg.includes("@nestjs/common");
    } catch {
      return false;
    }
  },
  relevant: (rel) => rel.endsWith(".ts") && !rel.endsWith(".d.ts"),
  apply(ctx: AdapterContext, files: AdapterFile[]): AdapterResult {
    let symbols = 0;
    let relations = 0;

    for (const f of files) {
      if (!f.content.includes("@Controller") && !f.content.includes("@Injectable")) {
        continue;
      }

      const fileSym = fileSymbolOf(ctx.db, f.fileId);
      if (!fileSym) continue;

      // Register routes
      const routes = parseNestRoutes(f.content);
      for (const r of routes) {
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

        // Hubungkan handler method ke route
        const handlerSym = ctx.db
          .prepare(
            `SELECT id FROM symbols WHERE file_id = ? AND name = ? AND type IN ('method', 'function') LIMIT 1`
          )
          .get(f.fileId, r.handler) as { id: number } | undefined;

        if (handlerSym) {
          insertRelation(ctx.db, handlerSym.id, routeId, "ROUTES_TO", 1.0, 1.0);
          relations++;
        }
      }

      // Register injectables (services/providers)
      const injectables = parseNestInjectables(f.content);
      for (const inj of injectables) {
        const classSym = ctx.db
          .prepare(`SELECT id FROM symbols WHERE file_id = ? AND name = ? AND type = 'class' LIMIT 1`)
          .get(f.fileId, inj.name) as { id: number } | undefined;

        if (classSym) {
          insertRelation(ctx.db, fileSym, classSym.id, "PROVIDES", 0.9, 1.0);
          relations++;
        }
      }
    }

    return { symbols, relations };
  },
};
