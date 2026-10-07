import fs from "node:fs";
import path from "node:path";
import { dataDir } from "../db.js";

// Protected berbasis pola path (PRD FR-07): tanpa parsing framework.
// Dapat dikonfigurasi di `.scopecairn/protected.yml` (satu pola per baris,
// `#` komentar, `!` negasi — kecocokan terakhir menang).

export const DEFAULT_PROTECTED_PATTERNS = [
  "migrations/**",
  "prisma/**",
  "schema.prisma",
  "*.sql",
  "alembic/**",
  ".env*",
  "package.json",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lockb",
];

function globToRegExp(pattern: string): RegExp {
  let re = "";
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i];
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        // `**/` → nol atau lebih segmen; `**` → apa saja
        if (pattern[i + 2] === "/") {
          re += "(.*/)?";
          i += 3;
        } else {
          re += ".*";
          i += 2;
        }
      } else {
        re += "[^/]*";
        i++;
      }
    } else if (c === "?") {
      re += "[^/]";
      i++;
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
      i++;
    }
  }
  return new RegExp(`^${re}$`);
}

export function matchPattern(pattern: string, posixPath: string): boolean {
  const base = posixPath.split("/").pop() ?? posixPath;
  if (pattern.endsWith("/")) {
    const dir = pattern.slice(0, -1);
    return posixPath === dir || posixPath.startsWith(dir + "/");
  }
  if (!pattern.includes("/")) {
    // Pola tanpa slash (mis. `*.sql`, `package.json`) cocok ke basename.
    return globToRegExp(pattern).test(base);
  }
  return globToRegExp(pattern).test(posixPath);
}

export function loadProtectedPatterns(repoRoot: string): string[] {
  const p = path.join(dataDir(repoRoot), "protected.yml");
  if (!fs.existsSync(p)) return [...DEFAULT_PROTECTED_PATTERNS];
  try {
    const patterns: string[] = [];
    for (const line of fs.readFileSync(p, "utf8").split("\n")) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      patterns.push(t);
    }
    return patterns.length > 0 ? patterns : [...DEFAULT_PROTECTED_PATTERNS];
  } catch {
    return [...DEFAULT_PROTECTED_PATTERNS];
  }
}

// Negasi `!`: pola terakhir yang cocok menentukan hasil.
export function isProtected(
  posixPath: string,
  patterns: string[] = DEFAULT_PROTECTED_PATTERNS
): boolean {
  let hit = false;
  for (const p of patterns) {
    if (p.startsWith("!")) {
      if (matchPattern(p.slice(1), posixPath)) hit = false;
    } else if (matchPattern(p, posixPath)) {
      hit = true;
    }
  }
  return hit;
}

export const SECRET_PATTERNS = [
  ".env",
  ".env.*",
  "*.pem",
  "*.key",
  "credentials.*",
  "secrets.*",
];

// Secret tak pernah terindeks — bahkan sebagai path (PRD §17).
export function isSecretFile(posixPath: string): boolean {
  return SECRET_PATTERNS.some((p) => matchPattern(p, posixPath));
}

const META_EXTS = new Set([
  ".json",
  ".yaml",
  ".yml",
  ".toml",
  ".sql",
  ".prisma",
  ".cfg",
  ".ini",
]);

const META_BASENAMES = new Set([
  "dockerfile",
  "makefile",
  "package.json",
]);

// File non-source yang tetap terindeks sebagai simpul file (tanpa isi):
// config, skema, migrasi — agar Protected/scope/impact melihatnya.
export function isIndexableMetaFile(
  posixPath: string,
  patterns?: string[]
): boolean {
  if (isSecretFile(posixPath)) return false;
  const base = (posixPath.split("/").pop() ?? "").toLowerCase();
  if (META_BASENAMES.has(base)) return true;
  const dot = base.lastIndexOf(".");
  if (dot !== -1 && META_EXTS.has(base.slice(dot))) return true;
  // Cocok pola Protected (mis. migrations/**) juga ikut terindeks.
  if (patterns ? isProtected(posixPath, patterns) : isProtected(posixPath)) return true;
  return false;
}

export function ensureProtectedFile(repoRoot: string): void {
  const dir = dataDir(repoRoot);
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, "protected.yml");
  if (!fs.existsSync(p)) {
    fs.writeFileSync(
      p,
      `# ScopeCairn Protected patterns (FR-07). Satu pola per baris, \`!\` negasi.\n` +
        DEFAULT_PROTECTED_PATTERNS.join("\n") +
        `\n`
    );
  }
}
