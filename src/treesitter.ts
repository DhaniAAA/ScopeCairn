import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { Language, Parser, type Node } from "web-tree-sitter";

const require = createRequire(import.meta.url);
const languages = new Map<string, Language>();
let initialization: Promise<void> | undefined;

function grammarPath(name: string): string {
  const file = `tree-sitter-${name}.wasm`;
  const bundled = path.join(path.dirname(fileURLToPath(import.meta.url)), "grammars", file);
  if (fs.existsSync(bundled)) return bundled;
  return path.join(path.dirname(require.resolve("tree-sitter-wasms/package.json")), "out", file);
}

export async function prepareTreeSitter(names: Iterable<string>): Promise<void> {
  initialization ??= Parser.init();
  await initialization;
  for (const name of new Set(names)) {
    if (!languages.has(name)) {
      languages.set(name, await Language.load(grammarPath(name)));
    }
  }
}

export function withSyntaxTree<T>(name: string, source: string, visit: (root: Node) => T): T {
  const language = languages.get(name);
  if (!language) throw new Error(`Grammar ${name} belum siap; panggil prepareTreeSitter terlebih dahulu`);
  const parser = new Parser();
  try {
    parser.setLanguage(language);
    const tree = parser.parse(source);
    if (!tree) throw new Error(`Gagal parse grammar ${name}`);
    try {
      return visit(tree.rootNode);
    } finally {
      tree.delete();
    }
  } finally {
    parser.delete();
  }
}

export async function checkTreeSitter(): Promise<{ ok: boolean; detail: string }> {
  try {
    await prepareTreeSitter(["typescript"]);
    return { ok: true, detail: "WASM runtime + TypeScript grammar OK" };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
}
