import fs from "node:fs";
import path from "node:path";
import { dataDir } from "../db.js";

// Bobot ranking PRD FR-05 — hipotesis awal, dikalibrasi di Fase 6.
// Dapat dioverride lewat `.scopecairn/config.yml` (format `key: value` sederhana).
export interface RetrievalConfig {
  wSeed: number;
  wProximity: number;
  wCentrality: number;
  wRecency: number;
  wCochange: number;
  maxDepth: number;
  topN: number;
  decayPerHop: number;
}

export const DEFAULT_CONFIG: RetrievalConfig = {
  wSeed: 0.3,
  wProximity: 0.35,
  wCentrality: 0.15,
  wRecency: 0.1,
  wCochange: 0.1,
  maxDepth: 2,
  topN: 20,
  decayPerHop: 0.7,
};

function parseSimpleYml(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf(":");
    if (i === -1) continue;
    out[t.slice(0, i).trim()] = t.slice(i + 1).trim();
  }
  return out;
}

export function loadConfig(repoRoot: string): RetrievalConfig {
  const cfg = { ...DEFAULT_CONFIG };
  const p = path.join(dataDir(repoRoot), "config.yml");
  if (!fs.existsSync(p)) return cfg;
  try {
    const kv = parseSimpleYml(fs.readFileSync(p, "utf8"));
    const num = (k: string, cur: number): number => {
      const v = Number(kv[k]);
      return Number.isFinite(v) ? v : cur;
    };
    cfg.wSeed = num("w_seed", cfg.wSeed);
    cfg.wProximity = num("w_proximity", cfg.wProximity);
    cfg.wCentrality = num("w_centrality", cfg.wCentrality);
    cfg.wRecency = num("w_recency", cfg.wRecency);
    cfg.wCochange = num("w_cochange", cfg.wCochange);
    cfg.maxDepth = Math.max(1, Math.min(4, Math.round(num("max_depth", cfg.maxDepth))));
    cfg.topN = Math.max(5, Math.min(100, Math.round(num("top_n", cfg.topN))));
  } catch {
    // corrupt config → defaults
  }
  return cfg;
}

// Glossary sinonim opsional (PRD FR-04): `.scopecairn/glossary.yml`
// Format: `approval: [authorize, persetujuan]` — satu istilah per baris.
export function loadGlossary(repoRoot: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const p = path.join(dataDir(repoRoot), "glossary.yml");
  if (!fs.existsSync(p)) return out;
  try {
    for (const line of fs.readFileSync(p, "utf8").split("\n")) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const i = t.indexOf(":");
      if (i === -1) continue;
      const term = t.slice(0, i).trim().toLowerCase();
      const aliases = t
        .slice(i + 1)
        .replace(/[[ \]]/g, "")
        .split(",")
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean);
      if (term && aliases.length > 0) out.set(term, aliases);
    }
  } catch {
    // ignore
  }
  return out;
}

import { ensureProtectedFile } from "../scope/protected.js";

// Default pola Protected (PRD FR-07) — dimiliki scope/protected.ts.
// Dipertahankan di sini agar impor lama tak rusak.
export const DEFAULT_PROTECTED_HINTS = [
  "migrations/",
  "prisma/",
  "alembic/",
  ".env",
  "package.json",
  "package-lock.json",
  "pnpm-lock.yaml",
];

export function ensureDefaultFiles(repoRoot: string): void {
  const dir = dataDir(repoRoot);
  fs.mkdirSync(dir, { recursive: true });
  const cfgPath = path.join(dir, "config.yml");
  if (!fs.existsSync(cfgPath)) {
    fs.writeFileSync(
      cfgPath,
      `# ScopeCairn retrieval config (bobot FR-05, dikalibrasi Fase 6)\n` +
        `w_seed: 0.3\nw_proximity: 0.35\nw_centrality: 0.15\nw_recency: 0.1\nw_cochange: 0.1\n` +
        `max_depth: 2\ntop_n: 20\n`
    );
  }
  const gloPath = path.join(dir, "glossary.yml");
  if (!fs.existsSync(gloPath)) {
    fs.writeFileSync(
      gloPath,
      `# Sinonim domain (opsional). Format: istilah: [alias1, alias2]\n# approval: [authorize, persetujuan]\n`
    );
  }
  ensureProtectedFile(repoRoot);
}
