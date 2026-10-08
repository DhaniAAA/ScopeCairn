import type {
  AdapterContext,
  AdapterFile,
  AdapterResult,
  FrameworkAdapter,
  QueryEdge,
} from "./types.js";
import {
  ensureAdapterSymbol,
  enclosingFunction,
  fileSymbolOf,
  findSymbolId,
  insertRelation,
  lineOf,
} from "./types.js";
import { WEIGHT } from "../extract/types.js";
import { withSyntaxTree } from "../treesitter.js";
import { grammarForPath } from "../extract/treeSitter.js";
import type { Node } from "web-tree-sitter";

// Adapter Next.js (FR-13): endpoint detection + referensi database.
// Mencakup App Router (`app/`), Pages Router (`pages/`), dan panggilan
// Prisma Client (`prisma.<model>.<op>()`) menjadi edge QUERIES.
//
// Batasan eksplisit (lihat juga doctor/benchmark):
// - Server Actions (`"use server"`) belum dipetakan.
// - Middleware (`middleware.ts`) dan Route Handler non-standar dilewati.
// - ORM selain Prisma (Drizzle, Mongoose, ...) belum didukung.

const API_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];

const PRISMA_OPS = [
  "findMany",
  "findUnique",
  "findFirst",
  "findFirstOrThrow",
  "findUniqueOrThrow",
  "create",
  "createMany",
  "update",
  "updateMany",
  "upsert",
  "delete",
  "deleteMany",
  "count",
  "aggregate",
  "groupBy",
];

export interface MappedRoute {
  /** Mis. `GET /api/requests`, `PAGE /dashboard`. */
  name: string;
  /** Handler pengekspor (mis. `GET`, `Page`) bila ada. */
  handler: string | null;
  line: number;
}

function stripSrcPrefix(rel: string): string {
  return rel.startsWith("src/") ? rel.slice(4) : rel;
}

function cleanSegments(segs: string[]): string[] {
  const out: string[] = [];
  for (let s of segs) {
    // Route group `(auth)` dan parallel route `@modal` tak mengubah URL.
    if (/^\(.*\)$/.test(s) || s.startsWith("@")) continue;
    // Intercepting route `(.)photo`, `(..)x`, `(...)x` → nama segmennya.
    s = s.replace(/^\(\.+\)/, "");
    if (s) out.push(s);
  }
  return out;
}

/** `app/dashboard/page.tsx` → PAGE; `app/api/r/route.ts` → API. Null bila konvensi. */
export function appRouteFromRel(rel: string): { kind: "page" | "route"; url: string } | null {
  const p = stripSrcPrefix(rel);
  if (!p.startsWith("app/")) return null;
  const parts = p.slice(4).split("/");
  const file = parts[parts.length - 1];
  const dir = cleanSegments(parts.slice(0, -1));
  const url = "/" + dir.join("/");
  if (/^page\.(tsx|ts|jsx|js|mdx?)$/.test(file)) return { kind: "page", url };
  if (/^route\.(ts|js)$/.test(file)) return { kind: "route", url };
  return null;
}

/** `pages/blog/[slug].tsx` → PAGE; `pages/api/a.ts` → API. Null bila konvensi (_app, dsb). */
export function pagesRouteFromRel(rel: string): { kind: "page" | "route"; url: string } | null {
  const p = stripSrcPrefix(rel);
  if (!p.startsWith("pages/")) return null;
  const rest = p.slice(6).replace(/\.(tsx|ts|jsx|js|mdx?)$/, "");
  if (rest.startsWith("_") || rest.startsWith("api/_")) return null;
  if (rest === "index") return { kind: "page", url: "/" };
  if (rest.startsWith("api/")) return { kind: "route", url: "/" + rest };
  if (rest.endsWith("/index")) return { kind: "page", url: "/" + rest.slice(0, -6) };
  return { kind: "page", url: "/" + rest };
}

/** True bila konten memuat direktif Server Actions (`"use server"` / `'use server'`). */
export function detectServerActions(content: string): boolean {
  return withSyntaxTree("typescript", content, (root) => {
    const visit = (node: Node): boolean => {
      if (node.type === "statement_block" || node.type === "program") {
        const directive = node.namedChildren.find((child) => child && child.type !== "comment");
        if (directive?.type === "expression_statement" && directive.namedChildren[0]?.type === "string" &&
            directive.namedChildren[0]?.text.slice(1, -1) === "use server") return true;
      }
      return node.namedChildren.some((child) => !!child && visit(child));
    };
    return visit(root);
  });
}

/** True bila path file adalah middleware Next.js (`middleware.ts`/`middleware.js`). */
export function detectMiddleware(rel: string): boolean {
  return /(^|\/)middleware\.(ts|js)$/.test(rel);
}

/** Handler yang diekspor route.ts: `export async function GET(`. */
function exportedHandlers(content: string, grammar: string): { method: string; line: number }[] {
  return withSyntaxTree(grammar, content, (root) => {
    const out: { method: string; line: number }[] = [];
    for (const node of root.namedChildren) {
      if (node?.type !== "export_statement") continue;
      const declaration = node.childForFieldName("declaration") ?? node.namedChildren.find((child) => child?.type === "function_declaration");
      const method = declaration?.type === "function_declaration" ? declaration.childForFieldName("name")?.text : null;
      if (method && API_METHODS.includes(method)) out.push({ method, line: node.startPosition.row + 1 });
    }
    return out;
  });
}

export function routeHandlers(content: string): { method: string; line: number }[] {
  return exportedHandlers(content, "typescript");
}

/** Panggilan Prisma: `prisma.request.findMany(` → { model: `request`, op }. */
function callsToPrisma(content: string, grammar: string): { model: string; op: string; index: number }[] {
  return withSyntaxTree(grammar, content, (root) => {
    const out: { model: string; op: string; index: number }[] = [];
    const visit = (node: Node) => {
      if (node.type === "call_expression") {
        const callee = node.childForFieldName("function");
        const modelMember = callee?.childForFieldName("object");
        const op = callee?.childForFieldName("property")?.text;
        const model = modelMember?.childForFieldName("property")?.text;
        if (callee?.type === "member_expression" && modelMember?.type === "member_expression" &&
            modelMember.childForFieldName("object")?.text === "prisma" && model && op && PRISMA_OPS.includes(op)) {
          out.push({ model, op, index: node.startIndex });
        }
      }
      for (const child of node.namedChildren) if (child) visit(child);
    };
    visit(root);
    return out;
  });
}

export function prismaCalls(content: string): { model: string; op: string; index: number }[] {
  return callsToPrisma(content, "typescript");
}

function resolveModel(db: AdapterContext["db"], name: string): number | null {
  return findSymbolId(db, name, ["model"]) ?? dbLowerModel(db, name);
}

/** Turunkan edge QUERIES Prisma untuk satu file (tanpa menulis DB). */
function prismaQueryEdges(
  db: AdapterContext["db"],
  fileId: number,
  content: string,
  grammar: string
): QueryEdge[] {
  const out: QueryEdge[] = [];
  const fileSym = fileSymbolOf(db, fileId);
  if (!fileSym) return out;
  for (const call of callsToPrisma(content, grammar)) {
    const modelId = resolveModel(db, call.model);
    if (!modelId) continue;
    const line = lineOf(content, call.index);
    const caller = enclosingFunction(db, fileId, line) ?? fileSym;
    if (caller === modelId) continue;
    out.push({
      callerId: caller,
      targetId: modelId,
      weight: WEIGHT.QUERIES,
      confidence: 0.9,
    });
  }
  return out;
}

export function derivePrismaQueries(
  db: AdapterContext["db"],
  fileId: number,
  content: string
): QueryEdge[] {
  return prismaQueryEdges(db, fileId, content, "typescript");
}

/** Hapus + turunkan ulang edge QUERIES untuk file-file ini. */
export function refreshQueries(
  db: AdapterContext["db"],
  files: { fileId: number; rel: string; content: string }[]
): number {
  let n = 0;
  const del = db.prepare(
    `DELETE FROM relationships WHERE relationship_type = 'QUERIES' AND source_id IN (SELECT id FROM symbols WHERE file_id = ?)`
  );
  const ins = db.prepare(
    `INSERT INTO relationships(source_id, target_id, relationship_type, weight, confidence)
     VALUES (?, ?, 'QUERIES', ?, ?)`
  );
  for (const f of files) {
    del.run(f.fileId);
    const grammar = grammarForPath(f.rel);
    if (!grammar) continue;
    for (const e of prismaQueryEdges(db, f.fileId, f.content, grammar)) {
      ins.run(e.callerId, e.targetId, e.weight, e.confidence);
      n++;
    }
  }
  return n;
}

export const nextjsAdapter: FrameworkAdapter = {
  id: "nextjs",
  label: "Next.js",
  detect: (files) =>
    files.some((f) => {
      const p = stripSrcPrefix(f);
      return (
        p.startsWith("app/") ||
        p.startsWith("pages/") ||
        /(^|\/)next\.config\.(js|ts|mjs)$/.test(f)
      );
    }),
  relevant: (rel) => {
    const p = stripSrcPrefix(rel);
    return p.startsWith("app/") || p.startsWith("pages/");
  },
  apply(ctx: AdapterContext, files: AdapterFile[]): AdapterResult {
    let symbols = 0;
    let relations = 0;
    for (const f of files) {
      const fileSym = fileSymbolOf(ctx.db, f.fileId);
      if (!fileSym) continue;
      const mapped = appRouteFromRel(f.rel) ?? pagesRouteFromRel(f.rel);
      if (mapped) {
        if (mapped.kind === "page") {
          const id = ensureAdapterSymbol(ctx.db, f.fileId, {
            name: `PAGE ${mapped.url}`,
            type: "route",
            signature: `page ${mapped.url}`,
            startLine: 1,
            endLine: 1,
          });
          symbols++;
          insertRelation(ctx.db, fileSym, id, "CONTAINS", 1.0, 1.0);
          relations++;
        } else {
          const handlers = exportedHandlers(f.content, grammarForPath(f.rel) ?? "typescript");
          if (handlers.length === 0) {
            // route.ts tanpa handler terekspor — catat rute tanpa edge handler.
            const id = ensureAdapterSymbol(ctx.db, f.fileId, {
              name: `API ${mapped.url}`,
              type: "route",
              signature: `route ${mapped.url} (no exported handler)`,
              startLine: 1,
              endLine: 1,
            });
            symbols++;
            insertRelation(ctx.db, fileSym, id, "CONTAINS", 1.0, 0.6);
            relations++;
          }
          for (const h of handlers) {
            const routeId = ensureAdapterSymbol(ctx.db, f.fileId, {
              name: `${h.method} ${mapped.url}`,
              type: "route",
              signature: `${h.method} ${mapped.url}`,
              startLine: h.line,
              endLine: h.line,
            });
            symbols++;
            insertRelation(ctx.db, fileSym, routeId, "CONTAINS", 1.0, 1.0);
            relations++;
            const handlerId = findInFile(ctx.db, f.fileId, h.method);
            if (handlerId) {
              insertRelation(ctx.db, handlerId, routeId, "ROUTES_TO", WEIGHT.ROUTES_TO, 1.0);
              relations++;
            }
          }
        }
      }
      // QUERIES diturunkan di refreshQueries di bawah (global, anti-basi).
    }
    relations += refreshQueries(
      ctx.db,
      files.map((f) => ({ fileId: f.fileId, rel: f.rel, content: f.content }))
    );
    return { symbols, relations };
  },
};

function dbLowerModel(db: AdapterContext["db"], name: string): number | null {
  const row = db
    .prepare(`SELECT id, name FROM symbols WHERE type = 'model'`)
    .all() as { id: number; name: string }[];
  const lower = name.toLowerCase();
  return row.find((r) => r.name.toLowerCase() === lower)?.id ?? null;
}

/** Cari simbol dalam file yang sama (handler route.ts tak boleh menabrak file lain). */
function findInFile(db: AdapterContext["db"], fileId: number, name: string): number | null {
  const row = db
    .prepare(`SELECT id FROM symbols WHERE file_id = ? AND name = ? LIMIT 1`)
    .get(fileId, name) as { id: number } | undefined;
  return row ? row.id : null;
}
