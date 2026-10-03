import fs from "node:fs";
import path from "node:path";
import ignore from "ignore";

// Default hard ignores — never indexed (PRD §17 + §7 FR-01).
// Directories + secret files.
const DEFAULT_DIR_IGNORES = [
  "node_modules/",
  ".git/",
  ".next/",
  "dist/",
  "build/",
  "coverage/",
  ".scopecairn/",
];

const DEFAULT_FILE_IGNORES = [
  ".env",
  ".env.*",
  "*.pem",
  "*.key",
  "credentials.*",
  "secrets.*",
  "*.min.js",
  "*.map",
];

export interface IgnoreRules {
  ig: ReturnType<typeof ignore>;
}

export function loadIgnoreRules(repoRoot: string): IgnoreRules {
  const ig = ignore();
  ig.add(DEFAULT_DIR_IGNORES);
  ig.add(DEFAULT_FILE_IGNORES);

  for (const name of [".gitignore", ".scopecairnignore"]) {
    const p = path.join(repoRoot, name);
    if (fs.existsSync(p)) {
      try {
        const content = fs.readFileSync(p, "utf8");
        ig.add(content);
      } catch {
        // ignore unreadable ignore files
      }
    }
  }
  return { ig };
}

export function isIgnored(relPosix: string, rules: IgnoreRules): boolean {
  // `ignore` expects posix relative paths.
  return rules.ig.ignores(relPosix);
}
