import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import type { DatabaseSync } from "node:sqlite";
import { openDb, dbPath } from "../db.js";
import { isTestPath } from "../retrieval/retrieve.js";
import { isSourceFile } from "../languages.js";
import { loadConfig } from "../retrieval/config.js";

import { fileURLToPath } from "node:url";

export type SupportedGateRunner = "vitest" | "jest" | "node" | "pytest" | "go" | "unsupported";

export type WeakenedTestKind = "assertion_removed" | "skip_added" | "matcher_loosened";

export interface WeakenedTestFinding {
  file: string;
  kind: WeakenedTestKind;
  detail: string;
  evidence: string;
}

export interface FileChangedCoverage {
  file: string;
  changedLines: number[];
  coveredLines: number[];
  uncoveredLines: number[];
  pct: number;
}

export interface ChangedCoverageReport {
  status: "pass" | "fail" | "skipped";
  runner: SupportedGateRunner;
  threshold: number;
  coveredLines: number;
  totalLines: number;
  pct: number;
  files: FileChangedCoverage[];
  reason?: string;
}

export interface MutationFileSummary {
  file: string;
  killed: number;
  survived: number;
  noCoverage: number;
  score: number;
}

export interface MutationGateReport {
  enabled: boolean;
  status: "pass" | "fail" | "skipped";
  runner: SupportedGateRunner;
  threshold: number;
  score: number | null;
  command: string | null;
  files: MutationFileSummary[];
  reason?: string;
}

export interface TestGateResult {
  ok: boolean;
  runner: SupportedGateRunner;
  weakenedTests: WeakenedTestFinding[];
  coverage: ChangedCoverageReport;
  mutation: MutationGateReport;
  limitationNote: string;
}

export interface TestGateOptions {
  base?: string;
  coverageThreshold?: number;
  mutation?: boolean;
  mutationThreshold?: number;
  runCoverage?: boolean;
  runMutation?: boolean;
}

export const BYPASS_LIMITATION_NOTE =
  "Keterbatasan hook lokal: agen dapat memakai `git commit --no-verify` untuk melewati pre-commit hook. Jalankan pemeriksaan yang sama secara wajib di CI: `scopecairn verify --test-gate --base origin/main`.";

/**
 * Deteksi test runner yang didukung gerbang testing (Vitest, Jest, Node test runner, pytest, Go).
 */
export function detectGateRunner(repoRoot: string): SupportedGateRunner {
  const vitestConfigs = [
    "vitest.config.ts",
    "vitest.config.mts",
    "vitest.config.js",
    "vitest.config.mjs",
  ];
  const jestConfigs = [
    "jest.config.ts",
    "jest.config.js",
    "jest.config.mjs",
    "jest.config.cjs",
    "jest.config.json",
  ];

  const pkgPath = path.join(repoRoot, "package.json");
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as {
        scripts?: Record<string, string>;
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
        jest?: unknown;
      };
      const testScript = pkg.scripts?.test ?? "";
      if (/\bvitest\b/.test(testScript)) return "vitest";
      if (/\bjest\b/.test(testScript)) return "jest";
      if (/\b(?:node|tsx)\s+[^\n]*--test\b/.test(testScript)) return "node";

      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      if (deps.vitest) return "vitest";
      if (deps.jest || pkg.jest !== undefined) return "jest";
    } catch {
      // ignore invalid package.json
    }
  }

  for (const c of vitestConfigs) {
    if (fs.existsSync(path.join(repoRoot, c))) return "vitest";
  }
  for (const c of jestConfigs) {
    if (fs.existsSync(path.join(repoRoot, c))) return "jest";
  }

  if (fs.existsSync(path.join(repoRoot, "pytest.ini")) || fs.existsSync(path.join(repoRoot, "conftest.py"))) {
    return "pytest";
  }
  const pyprojectPath = path.join(repoRoot, "pyproject.toml");
  if (fs.existsSync(pyprojectPath)) {
    try {
      const raw = fs.readFileSync(pyprojectPath, "utf8");
      if (/\bpytest\b/i.test(raw)) return "pytest";
    } catch {
      // ignore
    }
  }
  if (fs.existsSync(path.join(repoRoot, "go.mod"))) {
    return "go";
  }

  return "unsupported";
}

function isExecutableCodeLine(line: string): boolean {
  const t = line.trim();
  if (!t) return false;
  if (t.startsWith("//") || t.startsWith("/*") || t.startsWith("*") || t.startsWith("*/")) {
    return false;
  }
  if (/^[{}();,\]]+$/.test(t)) return false;
  if (/^(?:export\s+)?(?:interface|type)\s+[A-Za-z0-9_$]+/.test(t)) return false;
  if (/^import\s+type\b/.test(t)) return false;
  return true;
}

/**
 * Parse unified diff (`-U0`) untuk mengekstrak nomor baris pada versi baru (`+`) yang ditambahkan/diubah.
 */
export function parseChangedLineNumbersFromUnifiedDiff(diffText: string): number[] {
  const lines = new Set<number>();
  const hunkRe = /^@@\s+-\d+(?:,\d+)?\s+\+(\d+)(?:,(\d+))?\s+@@/;
  for (const rawLine of diffText.split("\n")) {
    const m = hunkRe.exec(rawLine.trim());
    if (!m) continue;
    const start = Number.parseInt(m[1], 10);
    const count = m[2] !== undefined ? Number.parseInt(m[2], 10) : 1;
    if (!Number.isFinite(start) || !Number.isFinite(count) || count <= 0) continue;
    for (let ln = start; ln < start + count; ln++) {
      lines.add(ln);
    }
  }
  return [...lines].sort((a, b) => a - b);
}

/**
 * Ekstrak nomor baris yang berubah (dan dapat dieksekusi) untuk setiap file sumber yang berubah.
 */
export function extractChangedLines(
  repoRoot: string,
  changedFiles: string[],
  baseRef?: string
): Map<string, number[]> {
  const out = new Map<string, number[]>();
  const sourceFiles = changedFiles.filter(
    (f) => !isTestPath(f) && isSourceFile(f) && !f.startsWith(".scopecairn/")
  );

  for (const rel of sourceFiles) {
    const abs = path.join(repoRoot, ...rel.split("/"));
    if (!fs.existsSync(abs)) continue;
    let fileLines: string[];
    try {
      fileLines = fs.readFileSync(abs, "utf8").replace(/\r\n/g, "\n").split("\n");
    } catch {
      continue;
    }

    const candidateLines = new Set<number>();
    let gotDiff = false;

    if (baseRef) {
      try {
        const dBase = execFileSync("git", ["diff", "-U0", `${baseRef}...HEAD`, "--", rel], {
          cwd: repoRoot,
          encoding: "utf8",
          timeout: 8000,
          stdio: ["ignore", "pipe", "ignore"],
        });
        for (const ln of parseChangedLineNumbersFromUnifiedDiff(dBase)) {
          candidateLines.add(ln);
        }
        if (dBase.trim().length > 0) gotDiff = true;
      } catch {
        // ignore
      }
    }

    try {
      const dHead = execFileSync("git", ["diff", "-U0", "HEAD", "--", rel], {
        cwd: repoRoot,
        encoding: "utf8",
        timeout: 8000,
        stdio: ["ignore", "pipe", "ignore"],
      });
      for (const ln of parseChangedLineNumbersFromUnifiedDiff(dHead)) {
        candidateLines.add(ln);
      }
      if (dHead.trim().length > 0) gotDiff = true;
    } catch {
      // ignore
    }

    // Jika file baru (untracked) dan belum ada di HEAD, semua baris kode dianggap baris berubah
    if (!gotDiff && candidateLines.size === 0) {
      for (let i = 1; i <= fileLines.length; i++) {
        candidateLines.add(i);
      }
    }

    const executableChanged = [...candidateLines]
      .filter((ln) => ln >= 1 && ln <= fileLines.length && isExecutableCodeLine(fileLines[ln - 1]))
      .sort((a, b) => a - b);

    if (executableChanged.length > 0) {
      out.set(rel, executableChanged);
    }
  }

  return out;
}

function normalizeRepoRel(repoRoot: string, rawFilePath: string): string {
  const absRoot = path.resolve(repoRoot).replace(/\\/g, "/").replace(/\/+$/, "");
  const norm = path.resolve(repoRoot, rawFilePath).replace(/\\/g, "/");
  if (norm.toLowerCase().startsWith(absRoot.toLowerCase() + "/")) {
    return norm.slice(absRoot.length + 1);
  }
  return rawFilePath.replace(/\\/g, "/").replace(/^\.\//, "");
}

function parseIstanbulCoverage(
  repoRoot: string,
  jsonPath: string
): Map<string, Map<number, number>> | null {
  if (!fs.existsSync(jsonPath)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(jsonPath, "utf8")) as Record<
      string,
      {
        path?: string;
        l?: Record<string, number>;
        statementMap?: Record<string, { start?: { line?: number }; end?: { line?: number } }>;
        s?: Record<string, number>;
      }
    >;
    const fileMap = new Map<string, Map<number, number>>();
    for (const [key, entry] of Object.entries(raw)) {
      const rel = normalizeRepoRel(repoRoot, entry.path ?? key);
      const lineHits = new Map<number, number>();
      if (entry.l && typeof entry.l === "object") {
        for (const [lnStr, hits] of Object.entries(entry.l)) {
          const ln = Number.parseInt(lnStr, 10);
          if (Number.isFinite(ln)) lineHits.set(ln, Number(hits) || 0);
        }
      } else if (entry.statementMap && entry.s) {
        for (const [stmtId, loc] of Object.entries(entry.statementMap)) {
          const hits = Number(entry.s[stmtId] ?? 0);
          const startLine = loc.start?.line;
          const endLine = loc.end?.line ?? startLine;
          if (startLine && endLine) {
            for (let ln = startLine; ln <= endLine; ln++) {
              const prev = lineHits.get(ln);
              lineHits.set(ln, prev === undefined ? hits : Math.max(prev, hits));
            }
          }
        }
      }
      fileMap.set(rel, lineHits);
    }
    return fileMap.size > 0 ? fileMap : null;
  } catch {
    return null;
  }
}

function parseLcovCoverage(
  repoRoot: string,
  lcovPath: string
): Map<string, Map<number, number>> | null {
  if (!fs.existsSync(lcovPath)) return null;
  try {
    const content = fs.readFileSync(lcovPath, "utf8");
    const fileMap = new Map<string, Map<number, number>>();
    let currentRel: string | null = null;
    for (const line of content.split(/\r?\n/)) {
      const t = line.trim();
      if (t.startsWith("SF:")) {
        currentRel = normalizeRepoRel(repoRoot, t.slice(3).trim());
        if (!fileMap.has(currentRel)) fileMap.set(currentRel, new Map());
      } else if (t.startsWith("DA:") && currentRel) {
        const parts = t.slice(3).split(",");
        const ln = Number.parseInt(parts[0], 10);
        const hits = Number.parseInt(parts[1] ?? "0", 10);
        if (Number.isFinite(ln) && Number.isFinite(hits)) {
          const prev = fileMap.get(currentRel)!.get(ln) ?? 0;
          fileMap.get(currentRel)!.set(ln, Math.max(prev, hits));
        }
      } else if (t === "end_of_record") {
        currentRel = null;
      }
    }
    return fileMap.size > 0 ? fileMap : null;
  } catch {
    return null;
  }
}

function buildLineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) starts.push(i + 1);
  }
  return starts;
}

function offsetToLine(starts: number[], offset: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (starts[mid] <= offset) lo = mid + 1;
    else hi = mid - 1;
  }
  return Math.max(1, hi + 1);
}

/**
 * Parse V8 Coverage JSON (`NODE_V8_COVERAGE` / `c8` / `node --test`) dari direktori coverage.
 */
function parseV8Coverage(repoRoot: string): Map<string, Map<number, number>> | null {
  const dirs = [
    path.join(repoRoot, "coverage", "v8"),
    path.join(repoRoot, "coverage", "tmp"),
    path.join(repoRoot, "coverage"),
  ];
  const fileMap = new Map<string, Map<number, number>>();
  const lineStartsCache = new Map<string, number[]>();

  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    let entries: string[];
    try {
      entries = fs.readdirSync(dir).filter((f) => f.endsWith(".json") && f !== "coverage-final.json");
    } catch {
      continue;
    }
    for (const file of entries) {
      try {
        const raw = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8")) as {
          result?: Array<{
            url?: string;
            functions?: Array<{
              ranges?: Array<{ startOffset?: number; endOffset?: number; count?: number }>;
            }>;
          }>;
        };
        if (!Array.isArray(raw.result)) continue;
        for (const script of raw.result) {
          if (!script.url?.startsWith("file://")) continue;
          let fsPath: string;
          try {
            fsPath = fileURLToPath(script.url);
          } catch {
            continue;
          }
          const rel = normalizeRepoRel(repoRoot, fsPath);
          if (rel.startsWith("..") || rel.includes("node_modules/")) continue;
          const abs = path.join(repoRoot, ...rel.split("/"));
          if (!fs.existsSync(abs)) continue;
          let starts = lineStartsCache.get(rel);
          if (!starts) {
            starts = buildLineStarts(fs.readFileSync(abs, "utf8"));
            lineStartsCache.set(rel, starts);
          }
          let lineHits = fileMap.get(rel);
          if (!lineHits) {
            lineHits = new Map<number, number>();
            fileMap.set(rel, lineHits);
          }
          for (const fn of script.functions ?? []) {
            for (const r of fn.ranges ?? []) {
              if (r.startOffset === undefined || r.endOffset === undefined) continue;
              const startLine = offsetToLine(starts, r.startOffset);
              const endLine = offsetToLine(starts, Math.max(r.startOffset, r.endOffset - 1));
              const hits = Number(r.count ?? 0);
              for (let ln = startLine; ln <= endLine; ln++) {
                const prev = lineHits.get(ln);
                // Rentang lebih sempit dengan hits 0 tidak menimpa eksekusi baris luar kecuali belum diset
                if (prev === undefined) lineHits.set(ln, hits);
                else if (hits > 0) lineHits.set(ln, Math.max(prev, hits));
              }
            }
          }
        }
      } catch {
        // ignore invalid v8 json
      }
    }
  }
  return fileMap.size > 0 ? fileMap : null;
}

function parseCoberturaCoverage(
  repoRoot: string,
  xmlPath: string
): Map<string, Map<number, number>> | null {
  if (!fs.existsSync(xmlPath)) return null;
  try {
    const raw = fs.readFileSync(xmlPath, "utf8");
    const fileMap = new Map<string, Map<number, number>>();
    const classRe = /<class\b[^>]*filename=["']([^"']+)["'][^>]*>([\s\S]*?)<\/class>/g;
    for (const cm of raw.matchAll(classRe)) {
      const rel = normalizeRepoRel(repoRoot, cm[1]);
      let lineHits = fileMap.get(rel);
      if (!lineHits) {
        lineHits = new Map<number, number>();
        fileMap.set(rel, lineHits);
      }
      for (const lm of cm[2].matchAll(/<line\b([^>]+)\/?>/g)) {
        const attrs = lm[1];
        const numMatch = /\bnumber=["'](\d+)["']/.exec(attrs);
        const hitsMatch = /\bhits=["'](\d+)["']/.exec(attrs);
        if (!numMatch || !hitsMatch) continue;
        const ln = Number.parseInt(numMatch[1], 10);
        const hits = Number.parseInt(hitsMatch[1], 10);
        const prev = lineHits.get(ln) ?? 0;
        lineHits.set(ln, Math.max(prev, hits));
      }
    }
    return fileMap.size > 0 ? fileMap : null;
  } catch {
    return null;
  }
}

function parseGoCoverprofile(
  repoRoot: string,
  profilePath: string
): Map<string, Map<number, number>> | null {
  if (!fs.existsSync(profilePath)) return null;
  try {
    const raw = fs.readFileSync(profilePath, "utf8");
    const fileMap = new Map<string, Map<number, number>>();
    const lineRe = /^(.+):(\d+)\.\d+,(\d+)\.\d+\s+\d+\s+(\d+)$/;
    for (const rawLine of raw.split(/\r?\n/)) {
      const t = rawLine.trim();
      if (!t || t.startsWith("mode:")) continue;
      const m = lineRe.exec(t);
      if (!m) continue;
      let rel = normalizeRepoRel(repoRoot, m[1]);
      if (!fs.existsSync(path.join(repoRoot, ...rel.split("/")))) {
        // Strip module prefix e.g. github.com/org/repo/pkg/a.go -> pkg/a.go
        const parts = m[1].replace(/\\/g, "/").split("/");
        for (let i = 1; i < parts.length; i++) {
          const sub = parts.slice(i).join("/");
          if (fs.existsSync(path.join(repoRoot, ...sub.split("/")))) {
            rel = sub;
            break;
          }
        }
      }
      const startLine = Number.parseInt(m[2], 10);
      const endLine = Number.parseInt(m[3], 10);
      const count = Number.parseInt(m[4], 10);
      let lineHits = fileMap.get(rel);
      if (!lineHits) {
        lineHits = new Map<number, number>();
        fileMap.set(rel, lineHits);
      }
      for (let ln = startLine; ln <= endLine; ln++) {
        const prev = lineHits.get(ln) ?? 0;
        lineHits.set(ln, Math.max(prev, count));
      }
    }
    return fileMap.size > 0 ? fileMap : null;
  } catch {
    return null;
  }
}

/**
 * Baca laporan coverage lintas bahasa & runner:
 * 1. Istanbul JSON (`coverage/coverage-final.json`)
 * 2. LCOV (`coverage/lcov.info`, `lcov.info`, `coverage/lcov/lcov.info`)
 * 3. V8 Coverage JSON (`coverage/v8/*.json`, `coverage/tmp/*.json`, `coverage/*.json`)
 * 4. Cobertura XML (`coverage/coverage.xml`, `coverage/cobertura-coverage.xml`, `coverage.xml`)
 * 5. Go coverprofile (`coverage/coverage.out`, `coverage.out`)
 */
export function parseCoverageReport(repoRoot: string): Map<string, Map<number, number>> | null {
  const istanbul = parseIstanbulCoverage(repoRoot, path.join(repoRoot, "coverage", "coverage-final.json"));
  if (istanbul) return istanbul;

  for (const rel of ["coverage/lcov.info", "lcov.info", "coverage/lcov/lcov.info"]) {
    const lcov = parseLcovCoverage(repoRoot, path.join(repoRoot, ...rel.split("/")));
    if (lcov) return lcov;
  }

  const v8 = parseV8Coverage(repoRoot);
  if (v8) return v8;

  for (const rel of ["coverage/coverage.xml", "coverage/cobertura-coverage.xml", "coverage.xml"]) {
    const cob = parseCoberturaCoverage(repoRoot, path.join(repoRoot, ...rel.split("/")));
    if (cob) return cob;
  }

  for (const rel of ["coverage/coverage.out", "coverage.out"]) {
    const goCov = parseGoCoverprofile(repoRoot, path.join(repoRoot, ...rel.split("/")));
    if (goCov) return goCov;
  }

  return null;
}

function npxBin(): string {
  return process.platform === "win32" ? "npx.cmd" : "npx";
}

function runRunnerCoverage(repoRoot: string, runner: SupportedGateRunner): void {
  fs.mkdirSync(path.join(repoRoot, "coverage"), { recursive: true });
  if (runner === "vitest") {
    spawnSync(npxBin(), ["vitest", "run", "--coverage", "--coverage.reporter=json"], {
      cwd: repoRoot,
      stdio: "ignore",
      shell: false,
      timeout: 60000,
    });
  } else if (runner === "jest") {
    spawnSync(npxBin(), ["jest", "--coverage", "--coverageReporters=json"], {
      cwd: repoRoot,
      stdio: "ignore",
      shell: false,
      timeout: 60000,
    });
  } else if (runner === "node") {
    let usesTsx = false;
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8")) as {
        scripts?: Record<string, string>;
      };
      usesTsx = /\btsx\b/.test(pkg.scripts?.test ?? "");
    } catch {
      usesTsx = false;
    }
    const args = [
      "--test",
      "--experimental-test-coverage",
      "--test-reporter=lcov",
      "--test-reporter-destination=coverage/lcov.info",
      ...(usesTsx ? ["--import", "tsx"] : []),
    ];
    spawnSync(process.execPath, args, {
      cwd: repoRoot,
      stdio: "ignore",
      shell: false,
      timeout: 60000,
    });
  } else if (runner === "pytest") {
    spawnSync("pytest", ["--cov", "--cov-report=xml:coverage/coverage.xml"], {
      cwd: repoRoot,
      stdio: "ignore",
      shell: false,
      timeout: 60000,
    });
  } else if (runner === "go") {
    spawnSync("go", ["test", "-coverprofile=coverage/coverage.out", "./..."], {
      cwd: repoRoot,
      stdio: "ignore",
      shell: false,
      timeout: 60000,
    });
  }
}

export function evaluateChangedLinesCoverage(
  repoRoot: string,
  changedFiles: string[],
  opts: { threshold: number; base?: string; runCoverage?: boolean }
): ChangedCoverageReport {
  const runner = detectGateRunner(repoRoot);
  const threshold = opts.threshold;
  const changedLinesMap = extractChangedLines(repoRoot, changedFiles, opts.base);

  if (changedLinesMap.size === 0) {
    return {
      status: "skipped",
      runner,
      threshold,
      coveredLines: 0,
      totalLines: 0,
      pct: 100,
      files: [],
      reason: "Tidak ada baris kode sumber yang diubah untuk diukur coverage-nya.",
    };
  }

  if (opts.runCoverage && runner !== "unsupported") {
    runRunnerCoverage(repoRoot, runner);
  }

  const coverageMap = parseCoverageReport(repoRoot);
  if (!coverageMap) {
    if (runner === "unsupported") {
      return {
        status: "skipped",
        runner,
        threshold,
        coveredLines: 0,
        totalLines: 0,
        pct: 0,
        files: [],
        reason:
          "Runner belum terdeteksi otomatis dan laporan coverage (Istanbul/LCOV/V8/Cobertura/Go) tidak ditemukan.",
      };
    }
    return {
      status: "skipped",
      runner,
      threshold,
      coveredLines: 0,
      totalLines: 0,
      pct: 0,
      files: [],
      reason: `Laporan coverage ${runner} belum ditemukan (Istanbul JSON, LCOV, V8 JSON, Cobertura XML, atau Go coverprofile). Jalankan dengan --run-coverage atau hasilkan laporan coverage lebih dulu.`,
    };
  }

  let totalLines = 0;
  let coveredLines = 0;
  const files: FileChangedCoverage[] = [];

  for (const [file, lines] of changedLinesMap.entries()) {
    const fileCov = coverageMap.get(file);
    const covered: number[] = [];
    const uncovered: number[] = [];

    for (const ln of lines) {
      const hits = fileCov?.get(ln) ?? 0;
      if (hits > 0) covered.push(ln);
      else uncovered.push(ln);
    }

    totalLines += lines.length;
    coveredLines += covered.length;
    const filePct =
      lines.length > 0 ? Math.round((covered.length / lines.length) * 10000) / 100 : 100;
    files.push({
      file,
      changedLines: lines,
      coveredLines: covered,
      uncoveredLines: uncovered,
      pct: filePct,
    });
  }

  const pct = totalLines > 0 ? Math.round((coveredLines / totalLines) * 10000) / 100 : 100;
  const status = pct >= threshold ? "pass" : "fail";

  return {
    status,
    runner,
    threshold,
    coveredLines,
    totalLines,
    pct,
    files,
    reason:
      status === "fail"
        ? `Coverage baris yang diubah ${pct}% di bawah ambang minimal ${threshold}%.`
        : undefined,
  };
}

function countRegexMatches(text: string, re: RegExp): number {
  const m = text.match(re);
  return m ? m.length : 0;
}

/**
 * Analisis unified diff pada satu file test untuk mendeteksi:
 * 1. `assertion_removed`: penghapusan `expect(...)` / `assert.*(...)`
 * 2. `skip_added`: penambahan `.skip`, `xit`, `xtest`, `.todo`, `{ skip: true }`
 * 3. `matcher_loosened`: penggantian matcher ketat (`toBe`/`toEqual`/`strictEqual`) menjadi matcher longgar (`toBeDefined`/`toBeTruthy`/`expect.anything()`) atau assertion tautologis (`expect(true).toBe(true)`)
 */
export function detectWeakenedTestsFromDiff(
  diffText: string,
  filePath: string
): WeakenedTestFinding[] {
  const findings: WeakenedTestFinding[] = [];
  const removedLines: string[] = [];
  const addedLines: string[] = [];

  for (const rawLine of diffText.split(/\r?\n/)) {
    if (rawLine.startsWith("---") || rawLine.startsWith("+++") || rawLine.startsWith("@@")) {
      continue;
    }
    if (rawLine.startsWith("-")) {
      const content = rawLine.slice(1).trim();
      if (content && !content.startsWith("//")) removedLines.push(content);
    } else if (rawLine.startsWith("+")) {
      const content = rawLine.slice(1).trim();
      if (content && !content.startsWith("//")) addedLines.push(content);
    }
  }

  if (removedLines.length === 0 && addedLines.length === 0) return findings;

  const removedText = removedLines.join("\n");
  const addedText = addedLines.join("\n");

  // 1. Deteksi assertion dihapus
  const assertionRe = /\b(?:expect\s*\(|assert(?:\.[A-Za-z]+)?\s*\()/g;
  const removedAssertions = countRegexMatches(removedText, assertionRe);
  const addedAssertions = countRegexMatches(addedText, assertionRe);
  if (removedAssertions > addedAssertions) {
    const sampleRemoved =
      removedLines.find((l) => /\b(?:expect\s*\(|assert(?:\.[A-Za-z]+)?\s*\()/.test(l)) ??
      removedLines[0];
    findings.push({
      file: filePath,
      kind: "assertion_removed",
      detail: `Assertion dihapus (berkurang dari ${removedAssertions} menjadi ${addedAssertions} pada diff test)`,
      evidence: `- ${sampleRemoved}`,
    });
  }

  // 2. Deteksi skip / todo ditambahkan (JS/TS, Python pytest, Go testing)
  const skipRe =
    /\b(?:it|test|describe)\.skip\s*\(|\b(?:xit|xtest|xdescribe)\s*\(|\b(?:it|test)\.todo\s*\(|\{\s*skip\s*:\s*true\b|@pytest\.mark\.skip\b|\bt\.Skip\s*\(/g;
  const removedSkips = countRegexMatches(removedText, skipRe);
  const addedSkips = countRegexMatches(addedText, skipRe);
  if (addedSkips > removedSkips) {
    const sampleSkip =
      addedLines.find((l) =>
        /\b(?:it|test|describe)\.skip\s*\(|\b(?:xit|xtest|xdescribe)\s*\(|\b(?:it|test)\.todo\s*\(|\{\s*skip\s*:\s*true\b/.test(
          l
        )
      ) ?? addedLines[0];
    findings.push({
      file: filePath,
      kind: "skip_added",
      detail: "Penambahan skip/todo yang menonaktifkan eksekusi test",
      evidence: `+ ${sampleSkip}`,
    });
  }

  // 3. Deteksi matcher dilonggarkan atau tautologis
  const tautologicalRe =
    /\bexpect\s*\(\s*(?:true|1)\s*\)\s*\.\s*(?:toBe\s*\(\s*(?:true|1)\s*\)|toBeTruthy\s*\(\s*\))|\bassert\.(?:ok|equal|strictEqual)\s*\(\s*true(?:\s*,\s*true)?\s*\)/;
  const tautologicalLine = addedLines.find((l) => tautologicalRe.test(l));
  if (tautologicalLine) {
    findings.push({
      file: filePath,
      kind: "matcher_loosened",
      detail: "Assertion tautologis ditambahkan (selalu bernilai true tanpa menguji perilaku)",
      evidence: `+ ${tautologicalLine}`,
    });
  } else {
    const strictMatcherRe =
      /\.(?:toBe|toEqual|toStrictEqual|toMatchObject)\s*\(|\bassert\.(?:equal|strictEqual|deepEqual|deepStrictEqual)\s*\(/g;
    const looseMatcherRe =
      /\.(?:toBeDefined|toBeTruthy)\s*\(\s*\)|\bexpect\.anything\s*\(\s*\)|\bassert\.ok\s*\(/g;

    const removedStrict = countRegexMatches(removedText, strictMatcherRe);
    const addedStrict = countRegexMatches(addedText, strictMatcherRe);
    const removedLoose = countRegexMatches(removedText, looseMatcherRe);
    const addedLoose = countRegexMatches(addedText, looseMatcherRe);

    const loosenedThrow =
      /\.toThrow\s*\(\s*[^)\s]+/.test(removedText) && /\.toThrow\s*\(\s*\)/.test(addedText);

    if ((removedStrict > addedStrict && addedLoose > removedLoose) || loosenedThrow) {
      const sampleAdded =
        addedLines.find((l) =>
          /\.(?:toBeDefined|toBeTruthy|toThrow)\s*\(|\bexpect\.anything\s*\(|\bassert\.ok\s*\(/.test(
            l
          )
        ) ?? addedLines[0];
      findings.push({
        file: filePath,
        kind: "matcher_loosened",
        detail: loosenedThrow
          ? "Matcher .toThrow(...) spesifik dilonggarkan menjadi .toThrow() kosong"
          : "Matcher spesifik (toBe/toEqual/strictEqual) dilonggarkan menjadi matcher generik (toBeDefined/toBeTruthy/assert.ok)",
        evidence: `+ ${sampleAdded}`,
      });
    }
  }

  return findings;
}

export function detectWeakenedTests(
  repoRoot: string,
  changedFiles: string[],
  baseRef?: string
): WeakenedTestFinding[] {
  const findings: WeakenedTestFinding[] = [];
  const testFiles = changedFiles.filter((f) => isTestPath(f));

  for (const rel of testFiles) {
    let diffText = "";
    if (baseRef) {
      try {
        diffText +=
          execFileSync("git", ["diff", `${baseRef}...HEAD`, "--", rel], {
            cwd: repoRoot,
            encoding: "utf8",
            timeout: 8000,
            stdio: ["ignore", "pipe", "ignore"],
          }) + "\n";
      } catch {
        // ignore
      }
    }
    try {
      diffText += execFileSync("git", ["diff", "HEAD", "--", rel], {
        cwd: repoRoot,
        encoding: "utf8",
        timeout: 8000,
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch {
      // ignore
    }

    if (!diffText.trim()) continue;
    findings.push(...detectWeakenedTestsFromDiff(diffText, rel));
  }

  return findings;
}

/**
 * Evaluasi hasil mutation test Stryker pada file yang diubah (opsional karena lambat).
 */
export function evaluateMutationGate(
  repoRoot: string,
  changedFiles: string[],
  opts: { enabled: boolean; threshold: number; runMutation?: boolean }
): MutationGateReport {
  const runner = detectGateRunner(repoRoot);
  const sourceFiles = changedFiles.filter(
    (f) => !isTestPath(f) && isSourceFile(f) && !f.startsWith(".scopecairn/")
  );

  const command =
    sourceFiles.length > 0 && (runner === "vitest" || runner === "jest")
      ? `npx stryker run --mutate ${sourceFiles.join(",")} --testRunner ${runner}`
      : null;

  if (!opts.enabled) {
    return {
      enabled: false,
      status: "skipped",
      runner,
      threshold: opts.threshold,
      score: null,
      command,
      files: [],
      reason:
        "Mutation test lewat Stryker bersifat opsional (lambat); aktifkan dengan --mutation atau `mutation_enabled: true` di .scopecairn/config.yml.",
    };
  }

  if (sourceFiles.length === 0) {
    return {
      enabled: true,
      status: "skipped",
      runner,
      threshold: opts.threshold,
      score: 100,
      command: null,
      files: [],
      reason: "Tidak ada file kode sumber yang diubah untuk diuji mutasi.",
    };
  }

  if (runner === "unsupported") {
    return {
      enabled: true,
      status: "skipped",
      runner,
      threshold: opts.threshold,
      score: null,
      command: null,
      files: [],
      reason: "Stryker mutation gate saat ini hanya mendukung Vitest dan Jest.",
    };
  }

  if (opts.runMutation && command) {
    spawnSync(
      npxBin(),
      ["stryker", "run", "--mutate", sourceFiles.join(","), "--testRunner", runner],
      { cwd: repoRoot, stdio: "ignore", shell: false, timeout: 180000 }
    );
  }

  const reportPath = path.join(repoRoot, "reports", "mutation", "mutation.json");
  if (!fs.existsSync(reportPath)) {
    return {
      enabled: true,
      status: "skipped",
      runner,
      threshold: opts.threshold,
      score: null,
      command,
      files: [],
      reason: `Laporan Stryker belum ditemukan di reports/mutation/mutation.json. Jalankan: ${command}`,
    };
  }

  try {
    const raw = JSON.parse(fs.readFileSync(reportPath, "utf8")) as {
      files?: Record<
        string,
        {
          mutants?: Array<{ status?: string }>;
        }
      >;
    };

    const changedSet = new Set(sourceFiles);
    const summaries: MutationFileSummary[] = [];
    let totalKilled = 0;
    let totalValid = 0;

    for (const [rawKey, fileEntry] of Object.entries(raw.files ?? {})) {
      const rel = normalizeRepoRel(repoRoot, rawKey);
      if (!changedSet.has(rel)) continue;

      let killed = 0;
      let survived = 0;
      let noCoverage = 0;

      for (const m of fileEntry.mutants ?? []) {
        if (m.status === "Killed" || m.status === "Timeout") killed++;
        else if (m.status === "Survived") survived++;
        else if (m.status === "NoCoverage") noCoverage++;
      }

      const valid = killed + survived + noCoverage;
      const fileScore = valid > 0 ? Math.round((killed / valid) * 10000) / 100 : 100;
      totalKilled += killed;
      totalValid += valid;
      summaries.push({
        file: rel,
        killed,
        survived,
        noCoverage,
        score: fileScore,
      });
    }

    const score = totalValid > 0 ? Math.round((totalKilled / totalValid) * 10000) / 100 : 100;
    const status = score >= opts.threshold ? "pass" : "fail";

    return {
      enabled: true,
      status,
      runner,
      threshold: opts.threshold,
      score,
      command,
      files: summaries,
      reason:
        status === "fail"
          ? `Mutation score ${score}% di bawah ambang minimal ${opts.threshold}%.`
          : undefined,
    };
  } catch {
    return {
      enabled: true,
      status: "skipped",
      runner,
      threshold: opts.threshold,
      score: null,
      command,
      files: [],
      reason: "Gagal membaca reports/mutation/mutation.json.",
    };
  }
}

export function runTestGate(
  repoRoot: string,
  changedFiles: string[],
  opts: TestGateOptions = {}
): TestGateResult {
  const cfg = loadConfig(repoRoot);
  const runner = detectGateRunner(repoRoot);
  const coverageThreshold = opts.coverageThreshold ?? cfg.coverageThreshold;
  const mutationEnabled = opts.mutation ?? cfg.mutationEnabled;
  const mutationThreshold = opts.mutationThreshold ?? cfg.mutationThreshold;

  const weakenedTests = detectWeakenedTests(repoRoot, changedFiles, opts.base);
  const coverage = evaluateChangedLinesCoverage(repoRoot, changedFiles, {
    threshold: coverageThreshold,
    base: opts.base,
    runCoverage: opts.runCoverage,
  });
  const mutation = evaluateMutationGate(repoRoot, changedFiles, {
    enabled: mutationEnabled,
    threshold: mutationThreshold,
    runMutation: opts.runMutation,
  });

  const ok =
    weakenedTests.length === 0 &&
    coverage.status !== "fail" &&
    mutation.status !== "fail";

  // Persist coverage per-simbol bila laporan ada + DB sudah ada (best-effort,
  // tak pernah menggagalkan gerbang; tak membuat DB baru pada pemakaian murni).
  try {
    tryPersistSymbolCoverage(repoRoot, changedFiles);
  } catch {
    // abaikan — gerbang tidak boleh gagal karena persistensi coverage
  }

  return {
    ok,
    runner,
    weakenedTests,
    coverage,
    mutation,
    limitationNote: BYPASS_LIMITATION_NOTE,
  };
}

// ---------------------------------------------------------------------------
// Coverage per-simbol (5.2): dari `coverage-final.json` / `lcov.info` yang
// sudah di-parse `parseCoverageReport`. Tabel dibuat lazily dengan
// `CREATE TABLE IF NOT EXISTS` agar DB lama tidak dimigrasi merusak —
// tabel absen berarti "belum pernah diukur", bukan "tidak ter-cover".
// ---------------------------------------------------------------------------

export interface SymbolCoverageEntry {
  symbolId: number;
  file: string;
  name: string;
  startLine: number;
  endLine: number;
  covered: boolean;
  hits: number;
  coveredLines: number;
  totalLines: number;
}

export interface SymbolRef {
  id: number;
  name: string;
  file: string;
  startLine: number;
  endLine: number;
}

export function ensureSymbolCoverageTable(db: DatabaseSync): void {
  db.exec(
    `CREATE TABLE IF NOT EXISTS symbol_coverage (
      symbol_id INTEGER PRIMARY KEY,
      file TEXT NOT NULL DEFAULT '',
      name TEXT NOT NULL DEFAULT '',
      start_line INTEGER NOT NULL DEFAULT 1,
      end_line INTEGER NOT NULL DEFAULT 1,
      covered INTEGER NOT NULL DEFAULT 0,
      hits INTEGER NOT NULL DEFAULT 0,
      covered_lines INTEGER NOT NULL DEFAULT 0,
      total_lines INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_symbol_coverage_file ON symbol_coverage(file);`
  );
}

export function computeSymbolCoverage(
  coverageMap: Map<string, Map<number, number>>,
  symbols: SymbolRef[]
): SymbolCoverageEntry[] {
  const out: SymbolCoverageEntry[] = [];
  for (const s of symbols) {
    const fileCov = coverageMap.get(s.file);
    let hits = 0;
    let coveredLines = 0;
    let totalLines = 0;
    if (fileCov) {
      for (let ln = s.startLine; ln <= s.endLine; ln++) {
        totalLines++;
        const h = fileCov.get(ln) ?? 0;
        if (h > hits) hits = h;
        if (h > 0) coveredLines++;
      }
    }
    out.push({
      symbolId: s.id,
      file: s.file,
      name: s.name,
      startLine: s.startLine,
      endLine: s.endLine,
      covered: coveredLines > 0,
      hits,
      coveredLines,
      totalLines,
    });
  }
  return out;
}

export function saveSymbolCoverage(db: DatabaseSync, entries: SymbolCoverageEntry[]): void {
  if (entries.length === 0) return;
  ensureSymbolCoverageTable(db);
  const stmt = db.prepare(
    `INSERT INTO symbol_coverage(symbol_id, file, name, start_line, end_line, covered, hits, covered_lines, total_lines, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(symbol_id) DO UPDATE SET
       file = excluded.file,
       name = excluded.name,
       start_line = excluded.start_line,
       end_line = excluded.end_line,
       covered = excluded.covered,
       hits = excluded.hits,
       covered_lines = excluded.covered_lines,
       total_lines = excluded.total_lines,
       updated_at = datetime('now')`
  );
  for (const e of entries) {
    stmt.run(
      e.symbolId,
      e.file,
      e.name,
      e.startLine,
      e.endLine,
      e.covered ? 1 : 0,
      e.hits,
      e.coveredLines,
      e.totalLines
    );
  }
}

export function getSymbolCoverage(db: DatabaseSync, symbolId: number): SymbolCoverageEntry | null {
  try {
    const row = db
      .prepare(
        `SELECT symbol_id AS symbolId, file, name, start_line AS startLine, end_line AS endLine,
                covered, hits, covered_lines AS coveredLines, total_lines AS totalLines
         FROM symbol_coverage WHERE symbol_id = ?`
      )
      .get(symbolId) as
      | {
          symbolId: number;
          file: string;
          name: string;
          startLine: number;
          endLine: number;
          covered: number;
          hits: number;
          coveredLines: number;
          totalLines: number;
        }
      | undefined;
    if (!row) return null;
    return { ...row, covered: row.covered === 1 };
  } catch {
    return null;
  }
}

export function getSymbolCoverages(db: DatabaseSync, file?: string): SymbolCoverageEntry[] {
  try {
    const sql = file
      ? `SELECT symbol_id AS symbolId, file, name, start_line AS startLine, end_line AS endLine,
                covered, hits, covered_lines AS coveredLines, total_lines AS totalLines
         FROM symbol_coverage WHERE file = ? ORDER BY startLine, name`
      : `SELECT symbol_id AS symbolId, file, name, start_line AS startLine, end_line AS endLine,
                covered, hits, covered_lines AS coveredLines, total_lines AS totalLines
         FROM symbol_coverage ORDER BY file, startLine, name`;
    const rows = (file ? db.prepare(sql).all(file) : db.prepare(sql).all()) as Array<{
      symbolId: number;
      file: string;
      name: string;
      startLine: number;
      endLine: number;
      covered: number;
      hits: number;
      coveredLines: number;
      totalLines: number;
    }>;
    return rows.map((r) => ({ ...r, covered: r.covered === 1 }));
  } catch {
    return [];
  }
}

/**
 * Simpan coverage per-simbol dari laporan yang sudah ada (`parseCoverageReport`).
 * Hanya berjalan bila DB sudah ada — tidak membuat DB baru. Gagal diam-diam.
 */
export function tryPersistSymbolCoverage(repoRoot: string, changedFiles: string[]): void {
  if (!fs.existsSync(dbPath(repoRoot))) return;
  const coverageMap = parseCoverageReport(repoRoot);
  if (!coverageMap || changedFiles.length === 0) return;
  const db = openDb(repoRoot);
  try {
    const ph = changedFiles.map(() => "?").join(",");
    const rows = db
      .prepare(
        `SELECT s.id AS id, s.name AS name, f.path AS file,
                s.start_line AS startLine, s.end_line AS endLine
         FROM symbols s JOIN files f ON f.id = s.file_id
         WHERE f.path IN (${ph}) AND s.type != 'file'`
      )
      .all(...changedFiles) as unknown as SymbolRef[];
    if (rows.length === 0) return;
    saveSymbolCoverage(db, computeSymbolCoverage(coverageMap, rows));
  } finally {
    db.close();
  }
}
