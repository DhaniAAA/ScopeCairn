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

export function parseVueImports(content: string): VueComponentImport[] {
  const out: VueComponentImport[] = [];
  const re = /import\s+(\w+)\s+from\s+["']([^"']+\.vue)["']/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    out.push({ name: m[1], source: m[2], line: lineOf(content, m.index) });
  }
  return out;
}

/** Tag PascalCase (`<UserCard`) atau kebab (`<user-card`) di <template>. */
export function parseTemplateTags(content: string): string[] {
  const tm = /<template[^>]*>([\s\S]*?)<\/template>/.exec(content);
  if (!tm) return [];
  const body = tm[1];
  const tags = new Set<string>();
  const re = /<\s*([A-Z][\w]*|[a-z][\w]*(?:-[\w]+)+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) tags.add(m[1]);
  return [...tags];
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

export function hasVueDefineComponent(content: string): boolean {
  return /\bdefineComponent\s*\(/.test(content);
}

function resolveImportRel(fromRel: string, source: string): string | null {
  if (!source.startsWith(".")) return null;
  const dir = fromRel.includes("/") ? fromRel.slice(0, fromRel.lastIndexOf("/")) : "";
  const parts = (dir ? dir + "/" + source : source).split("/");
  const out: string[] = [];
  for (const p of parts) {
    if (p === "" || p === ".") continue;
    if (p === "..") out.pop();
    else out.push(p);
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
      const line = hasVueDefineComponent(f.content)
        ? lineOf(f.content, f.content.search(/\bdefineComponent\s*\(/))
        : 1;
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
