import fs from "node:fs";
import path from "node:path";
import type {
  AdapterContext,
  AdapterFile,
  AdapterResult,
  FrameworkAdapter,
} from "./types.js";
import { ensureAdapterSymbol, fileSymbolOf, insertRelation, lineOf } from "./types.js";
import { WEIGHT } from "../extract/types.js";
import { withSyntaxTree } from "../treesitter.js";
import type { Node } from "web-tree-sitter";

// Adapter Vue SFC: simbol `component` dari nama file .vue (dan
// `defineComponent({...})`); komponen yang di-import lalu dipakai di
// `<template>` menjadi edge IMPORTS dari file ini ke file komponen.
// Batasan: komponen global/auto-import tanpa `import` dilewati.

export interface VueComponentImport {
  /** Nama lokal impor, mis. `UserCard`. */
  name: string;
  /** Path impor, mis. `./components/UserCard.vue`. */
  source: string;
  line: number;
}

function scripts(content: string): { text: string; line: number }[] {
  return withSyntaxTree("vue", content, (root) => root.namedChildren
    .filter((child): child is Node => child?.type === "script_element")
    .flatMap((child) => child.namedChildren
      .filter((part): part is Node => part?.type === "raw_text")
      .map((part) => ({ text: part.text, line: part.startPosition.row }))));
}

export function parseVueImports(content: string): VueComponentImport[] {
  const out: VueComponentImport[] = [];
  for (const script of scripts(content)) {
    try {
      out.push(...withSyntaxTree("javascript", script.text, (root) => {
        const imports: VueComponentImport[] = [];
        for (const node of root.namedChildren) {
          if (node?.type !== "import_statement") continue;
          const source = node.childForFieldName("source");
          const clause = node.namedChildren.find((child) => child?.type === "import_clause");
          const name = clause?.namedChildren.find((child) => child?.type === "identifier")?.text;
          if (name && source?.type === "string" && source.text.slice(1, -1).endsWith(".vue")) {
            imports.push({ name, source: source.text.slice(1, -1), line: script.line + node.startPosition.row + 1 });
          }
        }
        return imports;
      }));
    } catch (error) {
      if (!(error instanceof Error) || !error.message.startsWith("Grammar javascript belum siap")) throw error;
      const re = /\bimport\s+([A-Za-z_$][\w$]*)\s+from\s+["']([^"']+\.vue)["']/g;
      let match: RegExpExecArray | null;
      while ((match = re.exec(script.text)) !== null) {
        out.push({ name: match[1], source: match[2], line: script.line + lineOf(script.text, match.index) });
      }
    }
  }
  return out;
}

/** Tag PascalCase (`<UserCard`) atau kebab (`<user-card`) di <template>. */
export function parseTemplateTags(content: string): string[] {
  return withSyntaxTree("vue", content, (root) => {
    const tags = new Set<string>();
    const visit = (node: Node) => {
      if (node.type === "start_tag" || node.type === "self_closing_tag") {
        const tag = node.namedChildren.find((child) => child?.type === "tag_name")?.text;
        if (tag && (/^[A-Z]/.test(tag) || /^[a-z][\w]*-[\w-]+$/.test(tag))) tags.add(tag);
      }
      for (const child of node.namedChildren) if (child) visit(child);
    };
    for (const template of root.namedChildren.filter((child): child is Node => child?.type === "template_element")) visit(template);
    return [...tags];
  });
}

function kebabToPascal(s: string): string {
  return s
    .split("-")
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join("");
}

/** True bila komponen impor dipakai di template (nama cocok apa adanya / Pascal/kebab). */
export function usedVueComponents(content: string): VueComponentImport[] {
  const imports = parseVueImports(content);
  if (imports.length === 0) return [];
  const tags = new Set(parseTemplateTags(content));
  return imports.filter((imp) => {
    const kebab = imp.name
      .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
      .toLowerCase();
    return tags.has(imp.name) || tags.has(kebab) || tags.has(kebabToPascal(kebab));
  });
}

export function vueComponentName(rel: string): string {
  const base = rel.split("/").pop() ?? rel;
  return base.replace(/\.vue$/, "");
}

function defineComponentLine(content: string): number | null {
  for (const script of scripts(content)) {
    try {
      const line = withSyntaxTree("javascript", script.text, (root) => {
        let found: number | null = null;
        const visit = (node: Node) => {
          if (node.type === "call_expression" && node.childForFieldName("function")?.text === "defineComponent") {
            found ??= script.line + node.startPosition.row + 1;
          }
          for (const child of node.namedChildren) if (child) visit(child);
        };
        visit(root);
        return found;
      });
      if (line !== null) return line;
    } catch (error) {
      if (!(error instanceof Error) || !error.message.startsWith("Grammar javascript belum siap")) throw error;
      const match = /\bdefineComponent\s*\(/.exec(script.text);
      if (match) return script.line + lineOf(script.text, match.index);
    }
  }
  return null;
}

export function hasVueDefineComponent(content: string): boolean {
  return defineComponentLine(content) !== null;
}

function resolveImportRel(fromRel: string, source: string): string | null {
  if (!source.startsWith(".")) return null;
  const dir = fromRel.includes("/") ? fromRel.slice(0, fromRel.lastIndexOf("/")) : "";
  const parts = (dir ? dir + "/" + source : source).split("/");
  const out: string[] = [];
  for (const p of parts) {
    if (p === "" || p === ".") continue;
    if (p === "..") {
      if (out.length === 0) return null; // keluar dari root repo — tidak valid
      out.pop();
    } else out.push(p);
  }
  return out.join("/");
}

export const vueAdapter: FrameworkAdapter = {
  id: "vue",
  label: "Vue",
  detect: (files) =>
    files.some((f) => /\.vue$/.test(f) || f.endsWith("package.json")),
  confirm: (repoRoot) => {
    try {
      const pkg = fs.readFileSync(path.join(repoRoot, "package.json"), "utf8");
      return pkg.includes('"vue"') || pkg.includes("'vue'");
    } catch {
      return false;
    }
  },
  relevant: (rel) => /\.vue$/.test(rel),
  apply(ctx: AdapterContext, files: AdapterFile[]): AdapterResult {
    let symbols = 0;
    let relations = 0;
    for (const f of files) {
      const fileSym = fileSymbolOf(ctx.db, f.fileId);
      if (!fileSym) continue;
      const name = vueComponentName(f.rel);
      const line = defineComponentLine(f.content) ?? 1;
      const id = ensureAdapterSymbol(ctx.db, f.fileId, {
        name,
        type: "component",
        signature: `component ${name}`,
        startLine: line,
        endLine: line,
      });
      symbols++;
      insertRelation(ctx.db, fileSym, id, "CONTAINS", 1.0, 1.0);
      relations++;
      for (const imp of usedVueComponents(f.content)) {
        const targetRel = resolveImportRel(f.rel, imp.source);
        if (!targetRel) continue;
        const row = ctx.db
          .prepare(`SELECT id FROM files WHERE path = ? LIMIT 1`)
          .get(targetRel) as { id: number } | undefined;
        if (!row) continue;
        const targetFileSym = fileSymbolOf(ctx.db, row.id);
        if (!targetFileSym) continue;
        insertRelation(ctx.db, fileSym, targetFileSym, "IMPORTS", WEIGHT.IMPORTS, 0.9);
        relations++;
      }
    }
    return { symbols, relations };
  },
};
