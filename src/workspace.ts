import fs from "node:fs";
import path from "node:path";

export interface WorkspacePackage {
  name: string;
  /** Direktori relatif terhadap repoRoot dengan `/` (atau `""` untuk root). */
  dir: string;
  /** Path manifest relatif terhadap repoRoot. */
  manifestRel: string;
  ecosystem: "npm" | "python" | "go" | "rust";
  pkgJson?: Record<string, unknown>;
}

export interface TsConfigPaths {
  /** Direktori tempat tsconfig berada, relatif terhadap repoRoot ("" untuk root). */
  configDir: string;
  /** baseUrl relatif terhadap repoRoot ("" untuk root). */
  baseUrlRel: string;
  paths: Record<string, string[]>;
}

function toPosix(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
}

function readJsonSafe(absPath: string): Record<string, unknown> | null {
  try {
    if (!fs.existsSync(absPath)) return null;
    const raw = fs.readFileSync(absPath, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Map path output build (`dist/...`, `build/...`, `lib/...`) ke kandidat file sumber.
 * Jika `pkgDir` diberikan, kandidat diprefix dengan direktori package workspace.
 */
export function mapDistToSrc(p: string, pkgDir = ""): string[] {
  const norm = toPosix(p);
  const out = new Set<string>();
  const prefix = pkgDir ? `${toPosix(pkgDir)}/` : "";

  const add = (rel: string) => {
    const clean = toPosix(rel);
    if (!clean) return;
    out.add(prefix ? `${prefix}${clean}` : clean);
  };

  add(norm);
  if (norm.startsWith("dist/")) {
    const rest = norm.slice(5).replace(/\.(js|mjs|cjs|d\.ts)$/, "");
    add(`src/${rest}.ts`);
    add(`src/${rest}.tsx`);
    add(`src/${rest}.js`);
    add(`src/${rest}/index.ts`);
  } else if (norm.startsWith("build/") || norm.startsWith("lib/")) {
    const rest = norm.replace(/^(build|lib)\//, "").replace(/\.(js|mjs|cjs|d\.ts)$/, "");
    add(`src/${rest}.ts`);
    add(`src/${rest}.tsx`);
    add(`src/${rest}.js`);
  }
  const noExt = norm.replace(/\.(js|mjs|cjs)$/, "");
  if (noExt !== norm) {
    add(`${noExt}.ts`);
    add(`${noExt}.tsx`);
  }
  return [...out];
}

export function extractPathsFromExportsField(
  val: unknown,
  out: Set<string>,
  pkgDir = ""
): void {
  if (typeof val === "string") {
    for (const mapped of mapDistToSrc(val, pkgDir)) out.add(mapped);
  } else if (Array.isArray(val)) {
    for (const item of val) extractPathsFromExportsField(item, out, pkgDir);
  } else if (val && typeof val === "object") {
    for (const sub of Object.values(val as Record<string, unknown>)) {
      extractPathsFromExportsField(sub, out, pkgDir);
    }
  }
}

function expandWorkspacePattern(repoRoot: string, pattern: string): string[] {
  const clean = toPosix(pattern);
  if (!clean || clean === ".") return [];

  // Tangani pola sederhana: `packages/*`, `apps/**`, atau path langsung `packages/core`
  const segments = clean.split("/");
  const walkSegs = (baseAbs: string, idx: number, acc: string[]): void => {
    if (idx >= segments.length) {
      if (fs.existsSync(baseAbs) && fs.statSync(baseAbs).isDirectory()) {
        const rel = toPosix(path.relative(repoRoot, baseAbs));
        if (rel) acc.push(rel);
      }
      return;
    }
    const seg = segments[idx];
    if (seg === "**") {
      // Cocokkan 0..3 tingkat subdirektori agar tetap cepat
      walkSegs(baseAbs, idx + 1, acc);
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(baseAbs, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (!e.isDirectory() || e.name === "node_modules" || e.name.startsWith(".")) continue;
        walkSegs(path.join(baseAbs, e.name), idx, acc);
      }
      return;
    }
    if (seg.includes("*")) {
      const re = new RegExp(
        "^" + seg.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$"
      );
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(baseAbs, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (!e.isDirectory() || e.name === "node_modules" || e.name.startsWith(".")) continue;
        if (re.test(e.name)) {
          walkSegs(path.join(baseAbs, e.name), idx + 1, acc);
        }
      }
      return;
    }
    const nextAbs = path.join(baseAbs, seg);
    if (fs.existsSync(nextAbs)) {
      walkSegs(nextAbs, idx + 1, acc);
    }
  };

  const out: string[] = [];
  walkSegs(repoRoot, 0, out);
  return out;
}

function collectWorkspaceDirsFromGlobs(repoRoot: string, patterns: string[]): string[] {
  const included = new Set<string>();
  const excluded = new Set<string>();
  for (const raw of patterns) {
    const p = raw.trim().replace(/^["']|["']$/g, "");
    if (!p) continue;
    if (p.startsWith("!")) {
      for (const d of expandWorkspacePattern(repoRoot, p.slice(1))) excluded.add(d);
    } else {
      for (const d of expandWorkspacePattern(repoRoot, p)) included.add(d);
    }
  }
  return [...included].filter((d) => !excluded.has(d)).sort();
}

function parsePnpmWorkspacePatterns(repoRoot: string): string[] {
  const p = path.join(repoRoot, "pnpm-workspace.yaml");
  if (!fs.existsSync(p)) return [];
  try {
    const raw = fs.readFileSync(p, "utf8");
    const out: string[] = [];
    let inPackages = false;
    for (const line of raw.split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      if (/^packages\s*:/.test(t)) {
        inPackages = true;
        continue;
      }
      if (inPackages) {
        if (t.startsWith("-")) {
          const item = t.slice(1).trim().replace(/^["']|["']$/g, "");
          if (item) out.push(item);
        } else if (!/^\s/.test(line)) {
          inPackages = false;
        }
      }
    }
    return out;
  } catch {
    return [];
  }
}

function parseGoWorkDirs(repoRoot: string): string[] {
  const p = path.join(repoRoot, "go.work");
  if (!fs.existsSync(p)) return [];
  try {
    const raw = fs.readFileSync(p, "utf8");
    const dirs: string[] = [];
    for (const m of raw.matchAll(/use\s*\(([\s\S]*?)\)/g)) {
      for (const line of m[1].split(/\r?\n/)) {
        const t = line.replace(/\/\/.*$/, "").trim();
        if (t && t !== ".") dirs.push(toPosix(t));
      }
    }
    for (const line of raw.split(/\r?\n/)) {
      const t = line.replace(/\/\/.*$/, "").trim();
      const m = /^use\s+(\S+)$/.exec(t);
      if (m && m[1] !== "(" && m[1] !== ".") dirs.push(toPosix(m[1]));
    }
    return dirs;
  } catch {
    return [];
  }
}

function parseCargoWorkspaceMembers(repoRoot: string): string[] {
  const p = path.join(repoRoot, "Cargo.toml");
  if (!fs.existsSync(p)) return [];
  try {
    const raw = fs.readFileSync(p, "utf8");
    const wsMatch = /\[workspace\]([\s\S]*?)(?:\n\[|$)/.exec(raw);
    if (!wsMatch) return [];
    const membersMatch = /members\s*=\s*\[([\s\S]*?)\]/.exec(wsMatch[1]);
    if (!membersMatch) return [];
    const patterns: string[] = [];
    for (const sm of membersMatch[1].matchAll(/(["'])(.*?)\1/g)) {
      patterns.push(sm[2]);
    }
    return patterns;
  } catch {
    return [];
  }
}

/**
 * Temukan semua workspace package di monorepo (`package.json#workspaces`,
 * `pnpm-workspace.yaml`, `go.work`, `Cargo.toml [workspace]`).
 */
export function discoverWorkspaces(repoRoot: string): WorkspacePackage[] {
  const pkgs: WorkspacePackage[] = [];
  const seenManifests = new Set<string>();

  const npmPatterns: string[] = [];
  const rootPkg = readJsonSafe(path.join(repoRoot, "package.json"));
  if (rootPkg?.workspaces) {
    if (Array.isArray(rootPkg.workspaces)) {
      for (const w of rootPkg.workspaces) if (typeof w === "string") npmPatterns.push(w);
    } else if (typeof rootPkg.workspaces === "object") {
      const wsObj = rootPkg.workspaces as { packages?: unknown };
      if (Array.isArray(wsObj.packages)) {
        for (const w of wsObj.packages) if (typeof w === "string") npmPatterns.push(w);
      }
    }
  }
  npmPatterns.push(...parsePnpmWorkspacePatterns(repoRoot));

  for (const dir of collectWorkspaceDirsFromGlobs(repoRoot, npmPatterns)) {
    const manifestRel = `${dir}/package.json`;
    if (seenManifests.has(manifestRel)) continue;
    const pkgJson = readJsonSafe(path.join(repoRoot, ...manifestRel.split("/")));
    if (!pkgJson) continue;
    seenManifests.add(manifestRel);
    const name = typeof pkgJson.name === "string" ? pkgJson.name : path.posix.basename(dir);
    pkgs.push({ name, dir, manifestRel, ecosystem: "npm", pkgJson });
  }

  for (const dir of collectWorkspaceDirsFromGlobs(repoRoot, parseGoWorkDirs(repoRoot))) {
    const manifestRel = `${dir}/go.mod`;
    if (seenManifests.has(manifestRel)) continue;
    if (!fs.existsSync(path.join(repoRoot, ...manifestRel.split("/")))) continue;
    seenManifests.add(manifestRel);
    pkgs.push({ name: path.posix.basename(dir), dir, manifestRel, ecosystem: "go" });
  }

  for (const dir of collectWorkspaceDirsFromGlobs(repoRoot, parseCargoWorkspaceMembers(repoRoot))) {
    const manifestRel = `${dir}/Cargo.toml`;
    if (seenManifests.has(manifestRel)) continue;
    if (!fs.existsSync(path.join(repoRoot, ...manifestRel.split("/")))) continue;
    seenManifests.add(manifestRel);
    pkgs.push({ name: path.posix.basename(dir), dir, manifestRel, ecosystem: "rust" });
  }

  return pkgs;
}

/**
 * Strip komentar JSONC (`//`, `/* ... *\/`) dan trailing commas secara aman di luar string literal.
 */
function stripJsonc(text: string): string {
  let out = "";
  let inStr = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];
    if (inStr) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') {
      inStr = true;
      out += ch;
      continue;
    }
    if (ch === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
      continue;
    }
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i++;
      continue;
    }
    out += ch;
  }
  return out.replace(/,\s*([}\]])/g, "$1");
}

function readTsConfigMerged(
  repoRoot: string,
  tsconfigAbs: string,
  depth = 0
): { baseUrlRel?: string; paths: Record<string, string[]> } | null {
  if (depth > 3 || !fs.existsSync(tsconfigAbs)) return null;
  let parsed: {
    extends?: string;
    compilerOptions?: { baseUrl?: string; paths?: Record<string, string[]> };
  };
  try {
    parsed = JSON.parse(stripJsonc(fs.readFileSync(tsconfigAbs, "utf8")));
  } catch {
    return null;
  }

  let base: { baseUrlRel?: string; paths: Record<string, string[]> } = { paths: {} };
  if (typeof parsed.extends === "string" && parsed.extends.startsWith(".")) {
    let extPath = path.resolve(path.dirname(tsconfigAbs), parsed.extends);
    if (!extPath.endsWith(".json") && fs.existsSync(extPath + ".json")) {
      extPath += ".json";
    }
    const parent = readTsConfigMerged(repoRoot, extPath, depth + 1);
    if (parent) base = parent;
  }

  const configDirAbs = path.dirname(tsconfigAbs);
  const co = parsed.compilerOptions ?? {};
  const baseUrlRel =
    typeof co.baseUrl === "string"
      ? toPosix(path.relative(repoRoot, path.resolve(configDirAbs, co.baseUrl)))
      : base.baseUrlRel;

  const mergedPaths: Record<string, string[]> = { ...base.paths };
  if (co.paths && typeof co.paths === "object") {
    const anchorRel = baseUrlRel ?? toPosix(path.relative(repoRoot, configDirAbs));
    for (const [alias, targets] of Object.entries(co.paths)) {
      if (!Array.isArray(targets)) continue;
      mergedPaths[alias] = targets
        .filter((t): t is string => typeof t === "string")
        .map((t) => toPosix(path.posix.join(anchorRel || ".", t)));
    }
  }

  return { baseUrlRel, paths: mergedPaths };
}

/**
 * Muat konfigurasi `tsconfig.json` (`baseUrl` & `paths`) terdekat dari `fromRel`.
 */
export function loadTsConfigForFile(
  repoRoot: string,
  fromRel: string,
  cache?: Map<string, TsConfigPaths | null>
): TsConfigPaths | null {
  let curDir = toPosix(fromRel).includes("/")
    ? path.posix.dirname(toPosix(fromRel))
    : "";

  while (true) {
    const cfgRel = curDir ? `${curDir}/tsconfig.json` : "tsconfig.json";
    if (cache?.has(cfgRel)) {
      const hit = cache.get(cfgRel)!;
      if (hit !== null) return hit;
    } else {
      const abs = path.join(repoRoot, ...cfgRel.split("/"));
      if (fs.existsSync(abs)) {
        const merged = readTsConfigMerged(repoRoot, abs);
        const val: TsConfigPaths | null = merged
          ? {
              configDir: curDir,
              baseUrlRel: merged.baseUrlRel ?? curDir,
              paths: merged.paths,
            }
          : null;
        cache?.set(cfgRel, val);
        if (val) return val;
      } else {
        cache?.set(cfgRel, null);
      }
    }
    if (!curDir) break;
    const parent = path.posix.dirname(curDir);
    curDir = parent === "." ? "" : parent;
  }
  return null;
}

/**
 * Ubah module specifier menggunakan `tsconfig.json` `paths` dan `baseUrl` menjadi
 * daftar path kandidat relatif terhadap repoRoot.
 */
export function resolveTsPathCandidates(tsCfg: TsConfigPaths, spec: string): string[] {
  const out: string[] = [];
  for (const [pattern, targets] of Object.entries(tsCfg.paths)) {
    const starIdx = pattern.indexOf("*");
    if (starIdx === -1) {
      if (pattern === spec) {
        out.push(...targets);
      }
      continue;
    }
    const prefix = pattern.slice(0, starIdx);
    const suffix = pattern.slice(starIdx + 1);
    if (spec.startsWith(prefix) && spec.endsWith(suffix) && spec.length >= prefix.length + suffix.length) {
      const matched = spec.slice(prefix.length, spec.length - suffix.length);
      for (const t of targets) {
        out.push(toPosix(t.replace(/\*/g, matched)));
      }
    }
  }
  if (!spec.startsWith(".") && tsCfg.baseUrlRel !== undefined) {
    out.push(toPosix(tsCfg.baseUrlRel ? `${tsCfg.baseUrlRel}/${spec}` : spec));
  }
  return [...new Set(out)];
}

/**
 * Resolusi import paket workspace monorepo (mis. `@acme/core` atau `@acme/core/utils`).
 */
export function resolveWorkspaceImportCandidates(
  workspaces: WorkspacePackage[],
  spec: string
): string[] {
  if (spec.startsWith(".")) return [];
  const out: string[] = [];
  for (const ws of workspaces) {
    if (ws.ecosystem !== "npm") continue;
    if (spec === ws.name) {
      const pkg = ws.pkgJson ?? {};
      const entrySet = new Set<string>();
      for (const f of ["main", "module", "types"]) {
        if (typeof pkg[f] === "string") {
          for (const c of mapDistToSrc(pkg[f] as string, ws.dir)) entrySet.add(c);
        }
      }
      if (pkg.exports && typeof pkg.exports === "object") {
        const expObj = pkg.exports as Record<string, unknown>;
        if (expObj["."]) extractPathsFromExportsField(expObj["."], entrySet, ws.dir);
      } else if (typeof pkg.exports === "string") {
        extractPathsFromExportsField(pkg.exports, entrySet, ws.dir);
      }
      entrySet.add(`${ws.dir}/src/index`);
      entrySet.add(`${ws.dir}/index`);
      out.push(...entrySet);
    } else if (spec.startsWith(`${ws.name}/`)) {
      const sub = spec.slice(ws.name.length + 1);
      out.push(`${ws.dir}/src/${sub}`, `${ws.dir}/${sub}`);
    }
  }
  return [...new Set(out)];
}
