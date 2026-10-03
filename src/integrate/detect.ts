import fs from "node:fs";
import path from "node:path";

// Deteksi lingkungan instalasi agar prefix di AGENTS.md, Skill, dan
// allowlist IDENTIK (AI-9).

// AI-2: folder konfigurasi Antigravity berbeda antar versi.
// Bila sudah ada, hormati; bila belum, default `.agents/`.
export function detectAgentDir(repoRoot: string): ".agents" | ".agent" {
  const plural = fs.existsSync(path.join(repoRoot, ".agents"));
  const singular = fs.existsSync(path.join(repoRoot, ".agent"));
  if (singular && !plural) return ".agent";
  return ".agents";
}

// AI-9: bila scopecairn terdaftar di package.json proyek (install `-D`),
// instruksi memakai prefix `npx scopecairn`; bila tidak, `scopecairn` (global).
export function detectPrefix(repoRoot: string): "scopecairn" | "npx scopecairn" {
  try {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(repoRoot, "package.json"), "utf8")
    ) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    if (pkg.dependencies?.["scopecairn"] || pkg.devDependencies?.["scopecairn"]) {
      return "npx scopecairn";
    }
  } catch {
    // no package.json / unreadable → global
  }
  return "scopecairn";
}

// Ekstrak prefix yang dipakai sebuah file integrasi (`scopecairn context`
// vs `npx scopecairn context`) untuk cek konsistensi di doctor.
export function extractPrefixUsed(text: string): string | null {
  if (text.includes("npx scopecairn context")) return "npx scopecairn";
  if (/(^|[\s`"'`])scopecairn context/.test(text)) return "scopecairn";
  return null;
}
