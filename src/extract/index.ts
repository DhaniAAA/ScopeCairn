import { extractTypeScript } from "./typescript.js";
import { extractPython } from "./python.js";
import type { FileExtraction } from "./types.js";
import { detectLanguage } from "../languages.js";

export * from "./types.js";

// Dispatcher. Tree-sitter WASM grammars plug in here per language;
// regex fallback stays for zero-dep local-first operation.
export function extractFile(relPath: string, source: string): FileExtraction {
  const lang = detectLanguage(relPath);
  switch (lang) {
    case "typescript":
      return extractTypeScript(source, relPath.endsWith("x"));
    case "javascript":
      return extractTypeScript(source, relPath.endsWith("x"));
    case "python":
      return extractPython(source);
    default:
      return { symbols: [], relations: [] };
  }
}

// TESTS relation (PRD FR-03): test file -> source file it tests.
// Convention: foo.test.ts / foo.spec.ts / test_foo.py -> foo.*
// Returns { testRel, sourceRel } in posix relative paths, or null.
export function testTarget(testRel: string): string | null {
  const base = testRel.split("/").pop() ?? testRel;
  let stem: string | null = null;
  const m1 = base.match(/^(.+)\.(test|spec)\.[^.]+$/);
  if (m1) stem = m1[1];
  const m2 = base.match(/^test_(.+)\.py$/);
  if (m2) stem = m2[1];
  const m3 = base.match(/^(.+)_test\.py$/);
  if (m3) stem = m3[1];
  if (!stem) return null;
  const dir = testRel.includes("/") ? testRel.slice(0, testRel.lastIndexOf("/")) : "";
  // Try same dir + sibling src/ dir heuristics resolved by caller against file list.
  return (dir ? dir + "/" : "") + stem;
}
