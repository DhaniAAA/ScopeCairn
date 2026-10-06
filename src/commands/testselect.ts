import fs from "node:fs";
import path from "node:path";
import { openDb } from "../db.js";

function isTestPath(p: string): boolean {
  return (
    p.includes(".test.") ||
    p.includes(".spec.") ||
    p.includes("__tests__") ||
    path.basename(p).startsWith("test_")
  );
}

export function cmdTestSelect(repoRoot: string, target: string): void {
  const db = openDb(repoRoot);
  try {
    const rows = db.prepare(`SELECT path FROM files`).all() as { path: string }[];
    const testPaths = rows.map((r) => r.path).filter(isTestPath);

    const base = path.basename(target);
    const baseNoExt = base.replace(/\.[^./\\]+$/, "");
    const needles = new Set<string>([target, base, baseNoExt].filter((s) => s.length > 0));

    const matches: string[] = [];
    for (const rel of testPaths) {
      let content: string;
      try {
        content = fs.readFileSync(path.join(repoRoot, ...rel.split("/")), "utf8");
      } catch {
        continue;
      }
      for (const n of needles) {
        if (content.includes(n)) {
          matches.push(rel);
          break;
        }
      }
    }

    if (matches.length === 0) {
      console.log(`No tests reference "${target}".`);
      return;
    }
    console.log(`Tests referencing "${target}":`);
    for (const m of matches) console.log(`  ${m}`);
  } finally {
    db.close();
  }
}
