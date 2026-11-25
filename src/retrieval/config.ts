import fs from "node:fs";
import path from "node:path";
import { dataDir } from "../db.js";

// Bobot ranking PRD FR-05 — hipotesis awal, dikalibrasi di Fase 6.
// Dapat dioverride lewat `.scopecairn/config.yml` (format `key: value` sederhana).
export interface CustomSecretRuleConfig {
  label: string;
  pattern: string;
}

export interface RetrievalConfig {
  wSeed: number;
  wProximity: number;
  wCentrality: number;
  wRecency: number;
  wCochange: number;
  /** Bobot PPR/PageRank Fase 2 (default 0 = tidak memengaruhi skor lama). */
  wPpr: number;
  wPr: number;
  maxDepth: number;
  topN: number;
  decayPerHop: number;
  coverageThreshold: number;
  mutationEnabled: boolean;
  mutationThreshold: number;
  secretsAllowlist: string[];
  secretsRules: CustomSecretRuleConfig[];
}

export const DEFAULT_CONFIG: RetrievalConfig = {
  wSeed: 0.5,
  wProximity: 0.25,
  wCentrality: 0.1,
  wRecency: 0.1,
  wCochange: 0.1,
  wPpr: 0,
  wPr: 0,
  maxDepth: 2,
  topN: 20,
  decayPerHop: 0.7,
  coverageThreshold: 80,
  mutationEnabled: false,
  mutationThreshold: 60,
  secretsAllowlist: [],
  secretsRules: [],
};

function stripQuotes(s: string): string {
  const t = s.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1);
  }
  return t;
}

function parseInlineList(val: string): string[] {
  const t = val.trim();
  if (!t.startsWith("[") || !t.endsWith("]")) return [];
  const inner = t.slice(1, -1).trim();
  if (!inner) return [];
  const items: string[] = [];
  let cur = "";
  let quote: string | null = null;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (quote) {
      if (ch === "\\" && i + 1 < inner.length) {
        cur += inner[i + 1];
        i++;
      } else if (ch === quote) {
        quote = null;
      } else {
        cur += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === ",") {
      if (cur.trim()) items.push(stripQuotes(cur));
      cur = "";
    } else {
      cur += ch;
    }
  }
  if (cur.trim()) items.push(stripQuotes(cur));
  return items;
}

function parseSimpleYml(text: string): {
  kv: Record<string, string>;
  lists: Record<string, string[]>;
} {
  const kv: Record<string, string> = {};
  const lists: Record<string, string[]> = {};
  let activeListKey: string | null = null;
  for (const rawLine of text.split(/\r?\n/)) {
    const t = rawLine.trim();
    if (!t || t.startsWith("#")) continue;
    if (activeListKey && t.startsWith("- ") && /^\s+/.test(rawLine)) {
      lists[activeListKey].push(stripQuotes(t.slice(2)));
      continue;
    }
    const i = t.indexOf(":");
    if (i === -1) {
      activeListKey = null;
      continue;
    }
    const key = t.slice(0, i).trim();
    const val = t.slice(i + 1).trim();
    if (!val) {
      activeListKey = key;
      lists[key] = lists[key] ?? [];
    } else if (val.startsWith("[") && val.endsWith("]")) {
      activeListKey = null;
      lists[key] = parseInlineList(val);
    } else {
      activeListKey = null;
      kv[key] = stripQuotes(val);
    }
  }
  return { kv, lists };
}

function parseSecretRuleEntry(raw: string): CustomSecretRuleConfig | null {
  const t = raw.trim();
  if (!t) return null;
  if (t.startsWith("{")) {
    try {
      const obj = JSON.parse(t) as { label?: unknown; pattern?: unknown };
      if (typeof obj.label === "string" && typeof obj.pattern === "string" && obj.pattern) {
        return { label: obj.label, pattern: obj.pattern };
      }
    } catch {
      return null;
    }
  }
  const sep = t.indexOf("::");
  if (sep > 0) {
    const label = t.slice(0, sep).trim();
    const pattern = t.slice(sep + 2).trim();
    if (label && pattern) return { label, pattern };
  }
  return null;
}

export function loadConfig(repoRoot: string): RetrievalConfig {
  const cfg: RetrievalConfig = {
    ...DEFAULT_CONFIG,
    secretsAllowlist: [],
    secretsRules: [],
  };
  const p = path.join(dataDir(repoRoot), "config.yml");
  if (!fs.existsSync(p)) return cfg;
  try {
    const { kv, lists } = parseSimpleYml(fs.readFileSync(p, "utf8"));
    const num = (k: string, cur: number): number => {
      const v = Number(kv[k]);
      return Number.isFinite(v) ? v : cur;
    };
    cfg.wSeed = num("w_seed", cfg.wSeed);
    cfg.wProximity = num("w_proximity", cfg.wProximity);
    cfg.wCentrality = num("w_centrality", cfg.wCentrality);
    cfg.wRecency = num("w_recency", cfg.wRecency);
    cfg.wCochange = num("w_cochange", cfg.wCochange);
    cfg.wPpr = num("w_ppr", cfg.wPpr);
    cfg.wPr = num("w_pr", cfg.wPr);
    cfg.maxDepth = Math.max(1, Math.min(4, Math.round(num("max_depth", cfg.maxDepth))));
    cfg.topN = Math.max(5, Math.min(100, Math.round(num("top_n", cfg.topN))));
    cfg.decayPerHop = Math.max(0, Math.min(1, num("decay_per_hop", cfg.decayPerHop)));
    cfg.coverageThreshold = Math.max(
      0,
      Math.min(100, num("coverage_threshold", cfg.coverageThreshold))
    );
    if (kv.mutation_enabled !== undefined) {
      const rawMut = kv.mutation_enabled.toLowerCase();
      cfg.mutationEnabled = rawMut === "true" || rawMut === "1" || rawMut === "yes";
    }
    cfg.mutationThreshold = Math.max(
      0,
      Math.min(100, num("mutation_threshold", cfg.mutationThreshold))
    );
    if (lists.secrets_allowlist) {
      cfg.secretsAllowlist = lists.secrets_allowlist.filter(Boolean);
    }
    if (lists.secrets_rules) {
      cfg.secretsRules = lists.secrets_rules
        .map(parseSecretRuleEntry)
        .filter((r): r is CustomSecretRuleConfig => r !== null);
    }
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
        `w_seed: 0.5\nw_proximity: 0.25\nw_centrality: 0.1\nw_recency: 0.1\nw_cochange: 0.1\n` +
        `max_depth: 2\ntop_n: 20\ndecay_per_hop: 0.7\n` +
        `coverage_threshold: 80\nmutation_enabled: false\nmutation_threshold: 60\n`
    );
  }
  const gloPath = path.join(dir, "glossary.yml");
  if (!fs.existsSync(gloPath)) {
    fs.writeFileSync(
      gloPath,
      `# Sinonim domain (opsional). Format: istilah: [alias1, alias2]\n` +
        `# approval: [authorize, persetujuan]\n` +
        `# Bawaan morfologi Inggris agar recall seed tak hilang oleh\n` +
        `# bentuk kata (ranking/rank, configuration/config, dst).\n` +
        `ranking: [rank]\n` +
        `configuration: [config]\n` +
        `weights: [weight]\n` +
        `dependencies: [dependency]\n`
    );
  }
  ensureProtectedFile(repoRoot);
  const scIgnorePath = path.join(dir, ".gitignore");
  if (!fs.existsSync(scIgnorePath)) {
    fs.writeFileSync(scIgnorePath, "session.md\nscopecairn.db*\n", "utf8");
  }
}
