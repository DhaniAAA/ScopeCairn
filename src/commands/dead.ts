import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { openDb } from "../db.js";
import { logInvocation } from "../invocations.js";
import { refreshIndex } from "../refresh.js";
import { skipRefresh } from "./opts.js";
import { loadProtectedPatterns, isProtected, isIndexableMetaFile } from "../scope/protected.js";
import { isTestPath } from "../retrieval/retrieve.js";
import { appRouteFromRel, pagesRouteFromRel, detectMiddleware } from "../adapters/nextjs.js";

export type DeadConfidence = "high" | "medium" | "low";

export interface DeadOptions {
  json?: boolean;
  noRefresh?: boolean;
  refresh?: boolean;
}

export interface DeadFinding {
  path: string;
  name: string;
  type: string;
  startLine: number;
  endLine: number;
  exported: boolean;
  confidence: DeadConfidence;
  reason: string;
}

export interface DeadResult {
  total: number;
  byConfidence: {
    high: number;
    medium: number;
    low: number;
  };
  findings: DeadFinding[];
}

function mapDistToSrc(p: string): string[] {
  const norm = p.replace(/\\/g, "/").replace(/^\.\//, "");
  const out = new Set<string>([norm]);
  if (norm.startsWith("dist/")) {
    const rest = norm.slice(5).replace(/\.(js|mjs|cjs|d\.ts)$/, "");
    out.add(`src/${rest}.ts`);
    out.add(`src/${rest}.tsx`);
    out.add(`src/${rest}.js`);
    out.add(`src/${rest}/index.ts`);
  } else if (norm.startsWith("build/") || norm.startsWith("lib/")) {
    const rest = norm.replace(/^(build|lib)\//, "").replace(/\.(js|mjs|cjs|d\.ts)$/, "");
    out.add(`src/${rest}.ts`);
    out.add(`src/${rest}.tsx`);
    out.add(`src/${rest}.js`);
  }
  const noExt = norm.replace(/\.(js|mjs|cjs)$/, "");
  if (noExt !== norm) {
    out.add(`${noExt}.ts`);
    out.add(`${noExt}.tsx`);
  }
  return [...out];
}

function extractPathsFromExportsField(val: unknown, out: Set<string>): void {
  if (typeof val === "string") {
    for (const mapped of mapDistToSrc(val)) out.add(mapped);
  } else if (Array.isArray(val)) {
    for (const item of val) extractPathsFromExportsField(item, out);
  } else if (val && typeof val === "object") {
    for (const sub of Object.values(val as Record<string, unknown>)) {
      extractPathsFromExportsField(sub, out);
    }
  }
}

/**
 * Kumpulkan path file entrypoint dari package.json (main, bin, exports, module, types, scripts)
 * serta konvensi standar CLI/library.
 */
export function collectEntrypointPaths(repoRoot: string): Set<string> {
  const entrypoints = new Set<string>([
    "src/cli.ts",
    "src/cli.js",
    "src/index.ts",
    "src/index.js",
    "index.ts",
    "index.js",
    "main.ts",
    "main.py",
    "app.py",
    "manage.py",
  ]);

  const pkgPath = path.join(repoRoot, "package.json");
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as Record<string, unknown>;
      for (const field of ["main", "module", "types", "typings", "browser"]) {
        if (typeof pkg[field] === "string") {
          for (const m of mapDistToSrc(pkg[field] as string)) entrypoints.add(m);
        }
      }
      if (pkg.bin) {
        extractPathsFromExportsField(pkg.bin, entrypoints);
      }
      if (pkg.exports) {
        extractPathsFromExportsField(pkg.exports, entrypoints);
      }
      if (pkg.scripts && typeof pkg.scripts === "object") {
        for (const scriptCmd of Object.values(pkg.scripts as Record<string, unknown>)) {
          if (typeof scriptCmd !== "string") continue;
          const matches = scriptCmd.match(/(?:src|scripts)\/[A-Za-z0-9_./-]+\.(?:ts|tsx|js|mjs|cjs|py)/g);
          if (matches) {
            for (const m of matches) entrypoints.add(m.replace(/\\/g, "/"));
          }
        }
      }
    } catch {
      // abaikan bila package.json tidak valid
    }
  }

  return entrypoints;
}

/**
 * Cek apakah sebuah path adalah file route framework yang sudah dikenali
 * (Next.js App/Pages router, middleware, NestJS controller/module, Django urls/views).
 */
export function isFrameworkRouteFile(relPath: string, hasRouteSymbolInDb: boolean): boolean {
  if (hasRouteSymbolInDb) return true;
  const norm = relPath.replace(/\\/g, "/");
  if (appRouteFromRel(norm) !== null) return true;
  if (pagesRouteFromRel(norm) !== null) return true;
  if (detectMiddleware(norm)) return true;
  const base = norm.split("/").pop() ?? norm;
  if (
    /^layout\.(tsx|ts|jsx|js)$/.test(base) ||
    /^loading\.(tsx|ts|jsx|js)$/.test(base) ||
    /^error\.(tsx|ts|jsx|js)$/.test(base) ||
    /^not-found\.(tsx|ts|jsx|js)$/.test(base) ||
    /^template\.(tsx|ts|jsx|js)$/.test(base)
  ) {
    if (norm.startsWith("app/") || norm.startsWith("src/app/")) return true;
  }
  if (norm.endsWith(".controller.ts") || norm.endsWith(".module.ts")) return true;
  if (norm.endsWith("urls.py") || norm.endsWith("wsgi.py") || norm.endsWith("asgi.py")) return true;
  return false;
}

export function findDeadCode(db: DatabaseSync, repoRoot: string): DeadResult {
  const protectedPatterns = loadProtectedPatterns(repoRoot);
  const entrypoints = collectEntrypointPaths(repoRoot);

  const files = db
    .prepare(`SELECT id, path, language FROM files ORDER BY path`)
    .all() as { id: number; path: string; language: string }[];

  const routeFileIds = new Set<number>(
    (
      db
        .prepare(`SELECT DISTINCT file_id FROM symbols WHERE type = 'route'`)
        .all() as { file_id: number }[]
    ).map((r) => r.file_id)
  );

  // Semua simbol
  const allSymbols = db
    .prepare(
      `SELECT s.id, s.file_id AS fileId, s.name, s.type, s.signature,
              s.start_line AS startLine, s.end_line AS endLine, f.path AS path
       FROM symbols s
       JOIN files f ON f.id = s.file_id
       ORDER BY f.path, s.start_line, s.name`
    )
    .all() as {
    id: number;
    fileId: number;
    name: string;
    type: string;
    signature: string;
    startLine: number;
    endLine: number;
    path: string;
  }[];

  // Semua relationships masuk per target_id
  const allRels = db
    .prepare(
      `SELECT r.source_id AS sourceId, r.target_id AS targetId, r.relationship_type AS rel,
              s.file_id AS sourceFileId, s.type AS sourceType
       FROM relationships r
       JOIN symbols s ON s.id = r.source_id`
    )
    .all() as {
    sourceId: number;
    targetId: number;
    rel: string;
    sourceFileId: number;
    sourceType: string;
  }[];

  const inboundByTarget = new Map<number, typeof allRels>();
  const exportedSymbolIds = new Set<number>();

  for (const r of allRels) {
    if (r.rel === "EXPORTS" && r.sourceType === "file") {
      exportedSymbolIds.add(r.targetId);
    }
    const list = inboundByTarget.get(r.targetId);
    if (list) list.push(r);
    else inboundByTarget.set(r.targetId, [r]);
  }

  // Hitung file mana saja yang diimpor atau simbolnya dipakai dari file lain
  const filesReferencedExternally = new Set<number>();
  const symById = new Map(allSymbols.map((s) => [s.id, s]));
  for (const r of allRels) {
    const targetSym = symById.get(r.targetId);
    if (!targetSym) continue;
    if (r.sourceFileId !== targetSym.fileId) {
      filesReferencedExternally.add(targetSym.fileId);
    }
  }

  const excludedFileIds = new Set<number>();
  const CONFIG_FILE_RE = /(?:^|\/)(?:tsup|vite|vitest|jest|playwright|cypress|next|nuxt|astro|svelte|tailwind|postcss|eslint|prettier|rollup|webpack|babel|drizzle|prisma)\.config\.(?:ts|js|mjs|cjs|mts|cts)$/;
  for (const f of files) {
    const norm = f.path.replace(/\\/g, "/");
    if (
      entrypoints.has(norm) ||
      norm.startsWith("scripts/") ||
      CONFIG_FILE_RE.test(norm) ||
      isTestPath(norm) ||
      isProtected(norm, protectedPatterns) ||
      isIndexableMetaFile(norm, protectedPatterns) ||
      f.language === "other" ||
      isFrameworkRouteFile(norm, routeFileIds.has(f.id))
    ) {
      excludedFileIds.add(f.id);
    }
  }

  const findings: DeadFinding[] = [];
  const deadFileIds = new Set<number>();

  // 1. Cek simbol pada setiap file yang tidak dikecualikan
  const DEAD_SYMBOL_TYPES = new Set([
    "function",
    "class",
    "method",
    "interface",
    "type",
    "component",
  ]);
  for (const sym of allSymbols) {
    if (excludedFileIds.has(sym.fileId)) continue;
    if (sym.type === "file") {
      const inEdges = (inboundByTarget.get(sym.id) ?? []).filter(
        (e) => e.sourceId !== sym.id
      );
      if (inEdges.length === 0 && !filesReferencedExternally.has(sym.fileId)) {
        deadFileIds.add(sym.fileId);
        findings.push({
          path: sym.path,
          name: sym.name,
          type: "file",
          startLine: 1,
          endLine: 1,
          exported: false,
          confidence: "high",
          reason:
            "File tidak memiliki edge masuk (IMPORTS/TESTS) dan tidak ada simbol di dalamnya yang dirujuk oleh file lain.",
        });
      }
      continue;
    }
    if (!DEAD_SYMBOL_TYPES.has(sym.type)) continue;

    // Untuk simbol kode (function, class, method, interface, type, component, variable):
    // Abaikan edge struktural CONTAINS dan EXPORTS dari simbol file miliknya sendiri.
    const inEdges = (inboundByTarget.get(sym.id) ?? []).filter((e) => {
      if (e.sourceId === sym.id) return false;
      if (
        e.sourceFileId === sym.fileId &&
        e.sourceType === "file" &&
        (e.rel === "CONTAINS" || e.rel === "EXPORTS")
      ) {
        return false;
      }
      return true;
    });

    if (inEdges.length > 0) continue;

    const exported =
      exportedSymbolIds.has(sym.id) || /^export\b/.test(sym.signature.trim());

    let confidence: DeadConfidence;
    let reason: string;

    if (sym.type === "method" || sym.type === "component") {
      confidence = "low";
      reason =
        sym.type === "method"
          ? "Method tanpa edge CALLS statis masuk; berisiko dipanggil secara polimorfik, dinamis, atau lewat instance eksternal."
          : "Komponen tanpa edge masuk statis; berisiko dirender secara dinamis atau lewat template/framework.";
    } else if (sym.path.includes("adapters/") || sym.path.includes("plugin")) {
      confidence = exported ? "low" : "medium";
      reason = exported
        ? "Simbol adapter/plugin yang di-export tanpa edge masuk statis; mungkin dipakai lewat kontrak dinamis atau test eksternal."
        : "Simbol internal di modul adapter tanpa pemanggil statis.";
    } else if (exported) {
      confidence = "medium";
      reason =
        sym.type === "interface" || sym.type === "type"
          ? "Tipe/interface di-export tetapi tidak memiliki referensi statis (PARAM_TYPE/RETURN_TYPE/TYPED_AS/REFERENCES) di dalam repo; mungkin bagian dari kontrak publik."
          : "Simbol di-export (EXPORTS) tetapi tidak memiliki pemanggil atau pengimpor di dalam repo; mungkin bagian dari public API.";
    } else {
      confidence = "high";
      reason =
        "Simbol lokal (tidak di-export) dan tidak memiliki edge masuk (CALLS/REFERENCES/TYPED_AS) di dalam file-nya sendiri.";
    }

    findings.push({
      path: sym.path,
      name: sym.name,
      type: sym.type,
      startLine: sym.startLine,
      endLine: sym.endLine,
      exported,
      confidence,
      reason,
    });
  }

  // Urutkan high -> medium -> low, lalu path & baris
  const order: Record<DeadConfidence, number> = { high: 0, medium: 1, low: 2 };
  findings.sort(
    (a, b) =>
      order[a.confidence] - order[b.confidence] ||
      a.path.localeCompare(b.path) ||
      a.startLine - b.startLine
  );

  const byConfidence = {
    high: findings.filter((f) => f.confidence === "high").length,
    medium: findings.filter((f) => f.confidence === "medium").length,
    low: findings.filter((f) => f.confidence === "low").length,
  };

  return {
    total: findings.length,
    byConfidence,
    findings,
  };
}

export async function cmdDead(
  repoRoot: string,
  opts: DeadOptions = {}
): Promise<void> {
  if (!skipRefresh(opts)) {
    try {
      await refreshIndex(repoRoot);
    } catch {
      // best-effort refresh
    }
  }

  const db = openDb(repoRoot);
  try {
    logInvocation(db, "dead");
    const res = findDeadCode(db, repoRoot);

    if (opts.json) {
      console.log(JSON.stringify(res, null, 2));
      return;
    }

    console.log(`# ScopeCairn Dead Code Report\n`);
    console.log(
      `Excluded automatically: entrypoints (package.json main/bin/exports), test files, framework routes, and Protected paths.\n`
    );

    if (res.total === 0) {
      console.log(`✓ Tidak ditemukan dead code (0 node tanpa edge masuk).`);
      return;
    }

    console.log(
      `Ditemukan ${res.total} kandidat dead code (high: ${res.byConfidence.high}, medium: ${res.byConfidence.medium}, low: ${res.byConfidence.low}):\n`
    );

    for (const f of res.findings) {
      const exp = f.type === "file" ? "file" : f.exported ? "exported" : "local";
      const loc = f.type === "file" ? f.path : `${f.path}:${f.startLine}-${f.endLine}`;
      console.log(
        `- [${f.confidence.toUpperCase()}] **${f.name}** (${f.type}, ${exp}) — \`${loc}\``
      );
      console.log(`  Alasan: ${f.reason}`);
    }
    console.log(
      `\nCatatan: ScopeCairn tidak pernah menghapus kode secara otomatis. Periksa pemakaian dinamis sebelum menghapus.`
    );
  } finally {
    db.close();
  }
}
