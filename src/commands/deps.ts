import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { openDb } from "../db.js";
import { logInvocation } from "../invocations.js";
import { refreshIndex } from "../refresh.js";
import { skipRefresh } from "./opts.js";
import { discoverWorkspaces } from "../workspace.js";

export type DepEcosystem = "npm" | "python" | "go" | "rust";

export interface DepEntry {
  name: string;
  ecosystem: DepEcosystem;
  version: string;
  scope: string;
  package?: string;
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

function parsePackageJsonAt(pkgPath: string, pkgDir?: string): DepEntry[] {
  const raw = readText(pkgPath);
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
        out.push({
          name,
          ecosystem: "npm",
          version,
          scope,
          ...(pkgDir ? { package: pkgDir } : {}),
          used: false,
          evidence: "",
        });
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

function parsePyprojectAt(p: string, pkgDir?: string): DepEntry[] {
  const raw = readText(p);
  if (!raw) return [];
  const out: DepEntry[] = [];
  const seen = new Set<string>();
  const push = (name: string, scope: string) => {
    const n = name.trim();
    if (!n) return;
    if (n.toLowerCase() === "python" && scope.startsWith("poetry")) return;
    const key = `${scope}:${n}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({
      name: n,
      ecosystem: "python",
      version: "",
      scope,
      ...(pkgDir ? { package: pkgDir } : {}),
      used: false,
      evidence: "",
    });
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
  // [tool.poetry.dependencies] & [tool.poetry.group.<g>.dependencies]
  for (const m of raw.matchAll(/\[tool\.poetry(?:\.group\.[A-Za-z0-9_-]+)?\.dependencies\]([\s\S]*?)(?:\n\[|$)/g)) {
    for (const line of m[1].split("\n")) {
      const t = line.trim();
      if (!t || t.startsWith("#") || t.startsWith("[")) continue;
      const kv = t.match(/^([A-Za-z0-9._-]+)\s*=/);
      if (kv) push(kv[1], "poetry-dependencies");
    }
  }
  return out;
}

function parseGoModAt(p: string, pkgDir?: string): DepEntry[] {
  const raw = readText(p);
  if (!raw) return [];
  const out: DepEntry[] = [];
  const seen = new Set<string>();
  const push = (name: string, version: string) => {
    const n = name.trim();
    if (!n || seen.has(n)) return;
    seen.add(n);
    out.push({
      name: n,
      ecosystem: "go",
      version,
      scope: "require",
      ...(pkgDir ? { package: pkgDir } : {}),
      used: false,
      evidence: "",
    });
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

function parseCargoTomlAt(p: string, pkgDir?: string): DepEntry[] {
  const raw = readText(p);
  if (!raw) return [];
  const out: DepEntry[] = [];
  const seen = new Set<string>();
  const push = (name: string, version: string, scope: string) => {
    const n = name.trim();
    if (!n) return;
    if (n === "python" || n === "version" || n === "edition" || n === "rust-version") return;
    const key = `${scope}:${n}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({
      name: n,
      ecosystem: "rust",
      version,
      scope,
      ...(pkgDir ? { package: pkgDir } : {}),
      used: false,
      evidence: "",
    });
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
    ["package.json", () => parsePackageJsonAt(path.join(repoRoot, "package.json"))],
    ["pyproject.toml", () => parsePyprojectAt(path.join(repoRoot, "pyproject.toml"))],
    ["go.mod", () => parseGoModAt(path.join(repoRoot, "go.mod"))],
    ["Cargo.toml", () => parseCargoTomlAt(path.join(repoRoot, "Cargo.toml"))],
  ];
  for (const [name, fn] of candidates) {
    if (fs.existsSync(path.join(repoRoot, name))) {
      manifests.push(name);
      deps.push(...fn());
    }
  }

  for (const ws of discoverWorkspaces(repoRoot)) {
    if (manifests.includes(ws.manifestRel)) continue;
    const abs = path.join(repoRoot, ...ws.manifestRel.split("/"));
    if (!fs.existsSync(abs)) continue;
    manifests.push(ws.manifestRel);
    if (ws.ecosystem === "npm") deps.push(...parsePackageJsonAt(abs, ws.dir));
    else if (ws.ecosystem === "python") deps.push(...parsePyprojectAt(abs, ws.dir));
    else if (ws.ecosystem === "go") deps.push(...parseGoModAt(abs, ws.dir));
    else if (ws.ecosystem === "rust") deps.push(...parseCargoTomlAt(abs, ws.dir));
  }

  // Deterministik: urut ecosystem + package + nama agar output stabil & mudah difilter.
  deps.sort(
    (a, b) =>
      a.ecosystem.localeCompare(b.ecosystem) ||
      (a.package ?? "").localeCompare(b.package ?? "") ||
      a.name.localeCompare(b.name)
  );
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

const MANIFEST_BASENAMES = new Set(["package.json", "pyproject.toml", "go.mod", "Cargo.toml"]);

/** Baca isi file terindeks (berdasar DB `files`), kecuali manifest agar tidak self-match. */
function loadIndexedContents(
  db: DatabaseSync,
  repoRoot: string,
  limitFiles = 3000
): Map<string, string> {
  const out = new Map<string, string>();
  try {
    const rows = db.prepare(`SELECT path FROM files`).all() as { path: string }[];
    for (const r of rows.slice(0, limitFiles)) {
      const norm = r.path.replace(/\\/g, "/");
      const base = norm.split("/").pop() ?? norm;
      if (MANIFEST_BASENAMES.has(base)) continue;
      const abs = path.join(repoRoot, ...norm.split("/"));
      const content = readText(abs);
      if (content !== null) out.set(norm, content);
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
  const pkgPrefix = dep.package ? `${dep.package}/` : null;

  // 1. Cek DB: symbols (name/signature LIKE) & IMPORTS.
  // Pada monorepo workspace, batasi pencarian ke file di dalam paket tersebut.
  try {
    for (const term of terms) {
      const pat = `%${escapeLike(term)}%`;
      if (pkgPrefix) {
        const pkgPat = `${escapeLike(pkgPrefix)}%`;
        const symHit = db
          .prepare(
            `SELECT COUNT(*) AS n FROM symbols s JOIN files f ON f.id = s.file_id
             WHERE f.path LIKE ? ESCAPE '\\' AND (s.name LIKE ? ESCAPE '\\' OR s.signature LIKE ? ESCAPE '\\')`
          )
          .get(pkgPat, pat, pat) as { n: number };
        if (symHit.n > 0) return { used: true, evidence: `EXTRACTED (symbols LIKE in ${dep.package})` };
        const relHit = db
          .prepare(
            `SELECT COUNT(*) AS n FROM relationships r
             JOIN symbols s ON s.id = r.source_id
             JOIN files sf ON sf.id = s.file_id
             JOIN symbols t ON t.id = r.target_id
             WHERE sf.path LIKE ? ESCAPE '\\'
               AND r.relationship_type = 'IMPORTS' AND r.evidence = 'EXTRACTED' AND t.name LIKE ? ESCAPE '\\'`
          )
          .get(pkgPat, pat) as { n: number };
        if (relHit.n > 0) return { used: true, evidence: `EXTRACTED (IMPORTS in ${dep.package})` };
      } else {
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
    }
  } catch {
    // abaikan — lanjut ke file-scan
  }

  // 2. File-scan offline: cari import/require/use string dep di file terindeks.
  if (contents && contents.size > 0) {
    for (const term of terms) {
      const re = new RegExp(`(?:^|[^A-Za-z0-9_-])${escapeRegExp(term)}(?:[^A-Za-z0-9_-]|$)`);
      for (const [filePath, content] of contents.entries()) {
        if (pkgPrefix && !filePath.startsWith(pkgPrefix)) continue;
        if (re.test(content)) {
          return {
            used: true,
            evidence: pkgPrefix ? `file-scan (${dep.package})` : "file-scan (import string)",
          };
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
    const scopeLabel = d.package ? `${d.scope} (${d.package})` : d.scope;
    lines.push(
      `| ${d.name} | ${d.ecosystem} | ${scopeLabel} | ${d.version || "-"} | ${d.used ? "used" : "unused"} |`
    );
  }
  const unused = res.deps.filter((d) => !d.used);
  if (unused.length > 0) {
    lines.push(``);
    lines.push(`## Unused candidates (${unused.length})`);
    for (const d of unused) {
      const pkgSuffix = d.package ? `, ${d.package}` : "";
      lines.push(`- ${d.name} (${d.ecosystem}, ${d.scope}${pkgSuffix}) — evidence: ${d.evidence}`);
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
