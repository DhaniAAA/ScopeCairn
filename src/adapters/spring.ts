import fs from "node:fs";
import path from "node:path";
import type {
  AdapterContext,
  AdapterFile,
  AdapterResult,
  FrameworkAdapter,
} from "./types.js";
import { ensureAdapterSymbol, fileSymbolOf, insertRelation } from "./types.js";

// Adapter Spring: `@RestController` + `@GetMapping` / `@PostMapping`
// menjadi simbol `route`. Pola mengikuti nestjs.ts (regex decorator).
//   @RestController
//   public class UserController {
//     @GetMapping("/users")          -> GET /users -> listUsers
//     @PostMapping("/users")         -> POST /users -> createUser
//   }
// Prefix `@RequestMapping` di kelas (bila ada) digabungkan.

export interface SpringRoute {
  method: string;
  path: string;
  handler: string | null;
  line: number;
}

const MAPPING_METHODS: Record<string, string> = {
  Get: "GET",
  Post: "POST",
  Put: "PUT",
  Delete: "DELETE",
  Patch: "PATCH",
  Head: "HEAD",
  Options: "OPTIONS",
  Request: "ANY",
};

export function parseSpringRoutes(content: string): SpringRoute[] {
  const out: SpringRoute[] = [];
  // Prefix kelas: @RequestMapping("...") sebelum `class`.
  let prefix = "";
  const classIdx = content.search(/\bclass\s+\w+/);
  const classReq = /@RequestMapping\s*\(\s*(?:value\s*=\s*)?(['"`])([^'"`]+)\1/.exec(content);
  if (classReq && classReq[2] && !classReq[2].includes("{")) {
    const reqIdx = classReq.index;
    if (classIdx === -1 || reqIdx < classIdx) {
      prefix = classReq[2].trim();
      if (!prefix.startsWith("/")) prefix = "/" + prefix;
    }
  }

  // Cari tiap mapping; handler = method berikutnya (butuh modifier/return-type,
  // agar `@GetMapping(` sendiri tidak dianggap handler).
  const re =
    /@(Get|Post|Put|Delete|Patch|Head|Options|Request)Mapping\s*\(\s*(?:value\s*=\s*)?(?:(['"`])([^'"`]+)\2)?\s*\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    const verb = m[1];
    const sub = (m[3] ?? "").trim();
    // @RequestMapping di level kelas hanya prefix — bukan route sendiri.
    if (verb === "Request" && classIdx !== -1 && m.index < classIdx) continue;
    const after = content.slice(re.lastIndex, re.lastIndex + 800);
    const handlerMatch =
      /\b(?:public|private|protected|static|final|async|fun)\s+(?:[\w<>\[\].,\s?]+\s+)?([a-zA-Z0-9_$]+)\s*\(/.exec(after) ??
      /\b(?:public|private|protected|static|final)\s+(?:[\w<>\[\].,\s?]+\s+)?([a-zA-Z0-9_$]+)\s*\(/.exec(after);
    const handler = handlerMatch ? handlerMatch[1] : null;
    const combined = prefix + (sub ? (sub.startsWith("/") ? sub : "/" + sub) : "");
    const routePath = combined.replace(/\/+/g, "/") || "/";
    const line = content.slice(0, m.index).split("\n").length;
    out.push({
      method: MAPPING_METHODS[verb] ?? "ANY",
      path: routePath.startsWith("/") ? routePath : "/" + routePath,
      handler,
      line,
    });
  }
  return out;
}

export const springAdapter: FrameworkAdapter = {
  id: "spring",
  label: "Spring",
  detect: (files) => files.some((f) => f.endsWith(".java")),
  confirm: (repoRoot) => {
    for (const name of ["pom.xml", "build.gradle", "build.gradle.kts"]) {
      try {
        const c = fs.readFileSync(path.join(repoRoot, name), "utf8");
        if (c.includes("spring-boot") || c.includes("spring-web") || c.includes("org.springframework")) {
          return true;
        }
      } catch {
        // tidak ada file ini — lanjut
      }
    }
    return false;
  },
  relevant: (rel) => rel.endsWith(".java"),
  apply(ctx: AdapterContext, files: AdapterFile[]): AdapterResult {
    let symbols = 0;
    let relations = 0;
    for (const f of files) {
      if (!f.content.includes("@RestController") && !f.content.includes("@Controller") && !f.content.includes("Mapping")) {
        continue;
      }
      if (!f.content.includes("Mapping")) continue;
      const fileSym = fileSymbolOf(ctx.db, f.fileId);
      if (!fileSym) continue;
      for (const r of parseSpringRoutes(f.content)) {
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
