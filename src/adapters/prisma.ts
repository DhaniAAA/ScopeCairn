import type {
  AdapterContext,
  AdapterFile,
  AdapterResult,
  FrameworkAdapter,
} from "./types.js";
import { ensureAdapterSymbol, fileSymbolOf, insertRelation } from "./types.js";

// Adapter Prisma: membaca `schema.prisma` menjadi simbol `model`,
// agar adapter framework (Next.js, ...) bisa me-resolve edge QUERIES
// `prisma.request.findMany()` → model `Request` (case-insensitive:
// client memakai camelCase dari nama model PascalCase).

export function parsePrismaModels(content: string): { name: string; line: number }[] {
  const out: { name: string; line: number }[] = [];
  const re = /^model\s+(\w+)\s*\{/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    out.push({ name: m[1], line: content.slice(0, m.index).split("\n").length });
  }
  return out;
}

export const prismaAdapter: FrameworkAdapter = {
  id: "prisma",
  label: "Prisma",
  detect: (files) => files.some((f) => f.endsWith("schema.prisma")),
  relevant: (rel) => rel.endsWith("schema.prisma"),
  apply(ctx: AdapterContext, files: AdapterFile[]): AdapterResult {
    let symbols = 0;
    let relations = 0;
    for (const f of files) {
      const fileSym = fileSymbolOf(ctx.db, f.fileId);
      if (!fileSym) continue;
      for (const model of parsePrismaModels(f.content)) {
        const id = ensureAdapterSymbol(ctx.db, f.fileId, {
          name: model.name,
          type: "model",
          signature: `model ${model.name}`,
          startLine: model.line,
          endLine: model.line,
        });
        symbols++;
        insertRelation(ctx.db, fileSym, id, "CONTAINS", 1.0, 1.0);
        relations++;
      }
    }
    return { symbols, relations };
  },
};
