import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { openDb } from "../db.js";
import { logInvocation } from "../invocations.js";
import { refreshIndex } from "../refresh.js";
import { skipRefresh } from "./opts.js";

export type DepEcosystem = "npm" | "python" | "go" | "rust";

export interface DepEntry {
  name: string;
  ecosystem: DepEcosystem;
  version: string;
  scope: string;
  used: boolean;
  evidence: string;
}

export interface DepsResult {
  manifests: string[];
  total: number;
  usedCount: number;
  unusedCount: number;
  deps: DepEntry[];
}

export interface DepsOptions {
  json?: boolean;
  noRefresh?: boolean;
  refresh?: boolean;
}

function readText(p: string): string | null {
  try {
    if (!fs.existsSync(p)) return null;
    const st = fs.statSync(p);
    if (!st.isFile()) return null;
    if (st.size > 1_000_000) return null;
    return fs.readFileSync(p, "utf8");
  } catch {
    return null;
  }
}

function parsePackageJson(repoRoot: string): DepEntry[] {
  const p = path.join(repoRoot, "package.json");
  const raw = readText(p);
  if (!raw) return [];
  const out: DepEntry[] = [];
  try {
    const pkg = JSON.parse(raw) as Record<string, unknown>;
    const groups: Array<[string, string]> = [
      ["dependencies", "dependencies"],
      ["devDependencies", "devDependencies"],
      ["peerDependencies", "peerDependencies"],
      ["optionalDependencies", "optionalDependencies"],
    ];
    for (const [field, scope] of groups) {
      const map = pkg[field] as Record<string, string> | undefined;
      if (!map || typeof map !== "object") continue;
      for (const [name, version] of Object.entries(map)) {
        if (typeof version !== "string") continue;
        out.push({ name, ecosystem: "npm", version, scope, used: false, evidence: "" });
      }
    }
  } catch {
    return out;
  }
  return out;
}

function stripPySpecifier(s: string): string {
  const t = s.trim();
  // "requests>=2.0" / "Django==4.2" / "pytest (>=7)" -> nama saja
  const m = t.match(/^([A-Za-z0-9._-]+)/);
  return m ? m[1] : t;
}

function parsePyproject(repoRoot: string): DepEntry[] {
  const p = path.join(repoRoot, "pyproject.toml");
  const raw = readText(p);
  if (!raw) return [];
  const out: DepEntry[] = [];
  const seen = new Set<string>();
  const push = (name: string, scope: string) => {
    const n = name.trim();
    if (!n) return;
    const key = `${scope}:${n}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ name: n, ecosystem: "python", version: "", scope, used: false, evidence: "" });
  };
  // dependencies = [ "requests>=2", ... ] (multi-line)
  for (const m of raw.matchAll(/dependencies\s*=\s*\[(.*?)\]/gs)) {
    const body = m[1];
    for (const sm of body.matchAll(/(["'])(.*?)\1/g)) {
      push(stripPySpecifier(sm[2]), "dependencies");
    }
  }
  // requires = [ "poetry-core>=1.0" ]
  for (const m of raw.matchAll(/requires\s*=\s*\[(.*?)\]/gs)) {
    const body = m[1];
    for (const sm of body.matchAll(/(["'])(.*?)\1/g)) {
      push(stripPySpecifier(sm[2]), "build-requires");
    }
  }
  // [tool.poetry.dependencies] table: nama = "..." / nama = {version="..."}
  const poetryMatch = raw.match(/\[tool\.poetry\.dependencies\]([\s\S]*?)(?:\n\[|$)/);
  if (poetryMatch) {
    for (const line of poetryMatch[1].split("\n")) {
      const t = line.trim();
      if (!t || t.startsWith("#") || t.startsWith("[")) continue;
      const kv = t.match(/^([A-Za-z0-9._-]+)\s*=/);
      if (kv) push(kv[1], "poetry-dependencies");
    }
  }
  return out;
}

function parseGoMod(repoRoot: string): DepEntry[] {
  const p = path.join(repoRoot, "go.mod");
  const raw = readText(p);
  if (!raw) return [];
  const out: DepEntry[] = [];
  const seen = new Set<string>();
  const push = (name: string, version: string) => {
    const n = name.trim();
    if (!n || seen.has(n)) return;
    seen.add(n);
    out.push({ name: n, ecosystem: "go", version, scope: "require", used: false, evidence: "" });
  };
  for (const m of raw.matchAll(/require\s*\(([\s\S]*?)\)/g)) {
    for (const line of m[1].split("\n")) {
      const t = line.trim();
      if (!t || t.startsWith("//")) continue;
      const parts = t.split(/\s+/);
      if (parts.length >= 2) push(parts[0], parts[1]);
    }
  }
  for (const line of raw.split("\n")) {
    const t = line.trim();
    const m = t.match(/^require\s+(\S+)\s+(\S+)/);
    if (m) push(m[1], m[2]);
  }
  return out;
}

function parseCargoToml(repoRoot: string): DepEntry[] {
  const p = path.join(repoRoot, "Cargo.toml");
  const raw = readText(p);
  if (!raw) return [];
  const out: DepEntry[] = [];
  const seen = new Set<string>();
  const push = (name: string, version: string, scope: string) => {
    const n = name.trim();
    if (!n) return;
    // skip manifest helpers (package lookups) — hanya crate deps
    if (n === "python" || n === "version" || n === "edition" || n === "rust-version") return;
    const key = `${scope}:${n}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ name: n, ecosystem: "rust", version, scope, used: false, evidence: "" });
  };
  const sections: Array<[RegExp, string]> = [
    [/^\[dependencies\]\s*$/gm, "dependencies"],
    [/^\[dev-dependencies\]\s*$/gm, "devDependencies"],
    [/^\[build-dependencies\]\s*$/gm, "buildDependencies"],
    [/^\[workspace\.dependencies\]\s*$/gm, "dependencies"],
    [/^\[target\..*?\.dependencies\]\s*$/gm, "dependencies"],
  ];
  for (const [re, scope] of sections) {
    const m = raw.match(re);
    if (!m) continue;
    const start = m.index! + m[0].length;
    const rest = raw.slice(start);
    const endIdx = rest.search(/\n\[.+\]/);
    const body = endIdx >= 0 ? rest.slice(0, endIdx) : rest;
    for (const line of body.split("\n")) {
      const t = line.trim();
      if (!t || t.startsWith("#") || t.startsWith("[")) continue;
      const kv = t.match(/^([A-Za-z0-9._-]+)\s*=\s*(.+)$/);
      if (!kv) continue;
      const name = kv[1];
      const val = kv[2].trim();
      let version = "";
      const vm = val.match(/(["'])(.*?)\1/);
      if (vm) version = vm[2];
      else {
        const verObj = val.match(/version\s*=\s*(["'])(.*?)\1/);
        version = verObj ? verObj[2] : "";
      }
      push(name, version, scope);
    }
  }
  return out;
}

export function parseManifests(repoRoot: string): { manifests: string[]; deps: DepEntry[] } {
  const manifests: string[] = [];
  const deps: DepEntry[] = [];
  const candidates: Array<[string, () => DepEntry[]]> = [
    ["package.json", () => parsePackageJson(repoRoot)],
    ["pyproject.toml", () => parsePyproject(repoRoot)],
    ["go.mod", () => parseGoMod(repoRoot)],
    ["Cargo.toml", () => parseCargoToml(repoRoot)],
  ];
  for (const [name, fn] of candidates) {
    if (fs.existsSync(path.join(repoRoot, name))) {
      manifests.push(name);
      deps.push(...fn());
    }
  }
  // Deterministik: urut ecosystem + nama agar output stabil & mudah difilter.
  deps.sort((a, b) => a.ecosystem.localeCompare(b.ecosystem) || a.name.localeCompare(b.name));
  return { manifests, deps };
}

function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, (c) => `\\${c}`);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function depSearchTerms(dep: DepEntry): string[] {
  const terms = new Set<string>([dep.name]);
  if (dep.ecosystem === "npm" && dep.name.startsWith("@")) {
    const base = dep.name.split("/").pop();
    if (base) terms.add(base);
  }
  if (dep.ecosystem === "python") {
    terms.add(dep.name.replace(/-/g, "_"));
    terms.add(dep.name.replace(/_/g, "-"));
  }
  if (dep.ecosystem === "go") {
    const base = dep.name.split("/").pop();
    if (base) terms.add(base);
  }
  if (dep.ecosystem === "rust") {
    terms.add(dep.name.replace(/-/g, "_"));
    terms.add(dep.name.replace(/_/g, "-"));
  }
  return [...terms];
}

/** Baca isi file terindeks (berdasar DB `files`) untuk pencocokan import. */
function loadIndexedContents(
  db: DatabaseSync,
  repoRoot: string,
  limitFiles = 3000
): Map<string, string> {
  const out = new Map<string, string>();
  try {
    const rows = db.prepare(`SELECT path FROM files`).all() as { path: string }[];
    for (const r of rows.slice(0, limitFiles)) {
      const abs = path.join(repoRoot, ...r.path.replace(/\\/g, "/").split("/"));
      const content = readText(abs);
      if (content !== null) out.set(r.path.replace(/\\/g, "/"), content);
    }
  } catch {
    // DB kosong / skema lama — fallback kosong, deteksi hanya dari DB.
  }
  return out;
}

export function checkDepUsed(
  db: DatabaseSync,
  dep: DepEntry,
  contents?: Map<string, string>
): { used: boolean; evidence: string } {
  const terms = depSearchTerms(dep);

  // 1. Cek DB: symbols (name/signature LIKE) — IMPORTS tersimpan di
  // relationships; eksternal yang tak ter-resolve tidak ada di DB sehingga
  // langkah 2 (file-scan) wajib ada agar tidak semua dep ditandai unused.
  try {
    for (const term of terms) {
      const pat = `%${escapeLike(term)}%`;
      const symHit = db
        .prepare(`SELECT COUNT(*) AS n FROM symbols WHERE name LIKE ? ESCAPE '\\' OR signature LIKE ? ESCAPE '\\'`)
        .get(pat, pat) as { n: number };
      if (symHit.n > 0) return { used: true, evidence: "EXTRACTED (symbols LIKE)" };
      const relHit = db
        .prepare(
          `SELECT COUNT(*) AS n FROM relationships r
           JOIN symbols t ON t.id = r.target_id
           WHERE r.relationship_type = 'IMPORTS' AND r.evidence = 'EXTRACTED' AND t.name LIKE ? ESCAPE '\\'`
        )
        .get(pat) as { n: number };
      if (relHit.n > 0) return { used: true, evidence: "EXTRACTED (IMPORTS)" };
    }
  } catch {
    // abaikan — lanjut ke file-scan
  }

  // 2. File-scan offline: cari import/require/use string dep di file terindeks.
  if (contents && contents.size > 0) {
    for (const term of terms) {
      const re = new RegExp(`\\b${escapeRegExp(term)}\\b`);
      for (const content of contents.values()) {
        if (re.test(content)) {
          return { used: true, evidence: "file-scan (import string)" };
        }
      }
    }
  }

  return { used: false, evidence: "no IMPORTS/EXTRACTED match" };
}

export function findDependencies(db: DatabaseSync, repoRoot: string): DepsResult {
  const { manifests, deps } = parseManifests(repoRoot);
  const contents = loadIndexedContents(db, repoRoot);
  for (const d of deps) {
    const chk = checkDepUsed(db, d, contents);
    d.used = chk.used;
    d.evidence = chk.evidence;
  }
  const usedCount = deps.filter((d) => d.used).length;
  return {
    manifests,
    total: deps.length,
    usedCount,
    unusedCount: deps.length - usedCount,
    deps,
  };
}

function formatTable(res: DepsResult): string {
  const lines: string[] = [];
  lines.push(`# ScopeCairn Deps Report`);
  lines.push(``);
  const manifestLabel = res.manifests.length > 0 ? res.manifests.join(", ") : "-";
  lines.push(`Manifest: ${manifestLabel}`);
  lines.push(`Total: ${res.total} (used: ${res.usedCount}, unused: ${res.unusedCount})`);
  lines.push(``);
  lines.push(`| Dep | Ecosystem | Scope | Version | Status |`);
  lines.push(`|---|---|---|---|---|`);
  for (const d of res.deps) {
    lines.push(
      `| ${d.name} | ${d.ecosystem} | ${d.scope} | ${d.version || "-"} | ${d.used ? "used" : "unused"} |`
    );
  }
  const unused = res.deps.filter((d) => !d.used);
  if (unused.length > 0) {
    lines.push(``);
    lines.push(`## Unused candidates (${unused.length})`);
    for (const d of unused) {
      lines.push(`- ${d.name} (${d.ecosystem}, ${d.scope}) — evidence: ${d.evidence}`);
    }
  }
  return lines.join("\n");
}

export async function cmdDeps(repoRoot: string, opts: DepsOptions = {}): Promise<void> {
  if (!skipRefresh(opts)) {
    try {
      await refreshIndex(repoRoot);
    } catch {
      // best-effort refresh — deps tetap dihitung dari manifest + indeks lama
    }
  }

  const db = openDb(repoRoot);
  try {
    logInvocation(db, "deps");
    const res = findDependencies(db, repoRoot);
    if (opts.json) {
      console.log(JSON.stringify(res, null, 2));
      return;
    }
    console.log(formatTable(res));
    if (res.manifests.length === 0) {
      console.log(
        `\nTidak ada manifest ditemukan (package.json / pyproject.toml / go.mod / Cargo.toml).`
      );
    }
  } finally {
    db.close();
  }
}
