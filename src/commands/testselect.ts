import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { openDb } from "../db.js";

export function isTestPath(p: string): boolean {
  return (
    p.includes(".test.") ||
    p.includes(".spec.") ||
    p.includes("__tests__") ||
    path.basename(p).startsWith("test_")
  );
}

export interface TestSelectResult {
  target: string;
  tests: string[];
  runnerCommand?: string;
  /**
   * Bentuk aman untuk eksekusi: argv terpisah, tanpa shell.
   * `runnerCommand` hanya untuk ditampilkan — jangan pernah di-`split` lalu
   * dieksekusi, karena `files.path` bisa berisi metakarakter shell.
   */
  runnerArgv?: string[];
}

interface RunnerPlan {
  /** String siap tampil, mis. `npx vitest run tests/a.test.ts`. */
  command: string;
  /** argv terpisah untuk `spawnSync(..., { shell: false })`. */
  argv: string[];
}

// Di Windows `npx`/`npm` adalah shim `.cmd` yang tidak bisa di-exec tanpa
// shell. Memakai nama `.cmd` secara eksplisit membuat `shell: false` aman,
// sehingga tidak ada opportunity injeksi dari path file yang diindeks.
function bin(name: "npx" | "npm"): string {
  return process.platform === "win32" ? `${name}.cmd` : name;
}

/** Runner yang bisa dieksekusi langsung — nama bin sama untuk display & argv. */
function plan(argv: string[]): RunnerPlan {
  return { command: argv.join(" "), argv };
}

/**
 * Runner berbasis npm/npx. String yang DITAMPILKAN tetap `npx`/`npm` supaya
 * bisa di-copy-paste; hanya argv eksekusi yang memakai shim `.cmd` di Windows.
 */
function planNpm(binName: "npx" | "npm", args: string[]): RunnerPlan {
  return {
    command: [binName, ...args].join(" "),
    argv: [bin(binName), ...args],
  };
}

/**
 * Susun perintah test runner. `testFiles` berasal dari kolom `files.path`
 * (hasil scan repo), jadi HARUS tetap per-element — tidak boleh digabung
 * menjadi string yang lalu di-`split`.
 */
export function detectTestRunnerPlan(
  repoRoot: string,
  testFiles: string[]
): RunnerPlan | undefined {
  if (testFiles.length === 0) return undefined;
  const pkgPath = path.join(repoRoot, "package.json");
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
      const testScript = (pkg.scripts && pkg.scripts.test) || "";
      if (testScript.includes("vitest")) {
        return planNpm("npx", ["vitest", "run", ...testFiles]);
      }
      if (testScript.includes("jest")) {
        return planNpm("npx", ["jest", ...testFiles]);
      }
      if (testScript.includes("tsx --test") || testScript.includes("node --test")) {
        return planNpm("npx", ["tsx", "--test", ...testFiles]);
      }
      // General npm test with files passed
      return planNpm("npm", ["test", "--", ...testFiles]);
    } catch {
      // ignore
    }
  }

  // Check Python
  if (fs.existsSync(path.join(repoRoot, "pytest.ini")) || fs.existsSync(path.join(repoRoot, "pyproject.toml"))) {
    return plan(["pytest", ...testFiles]);
  }

  // Check Go
  if (fs.existsSync(path.join(repoRoot, "go.mod"))) {
    const dirs = Array.from(new Set(testFiles.map((f) => path.dirname(f))));
    return plan(["go", "test", ...dirs.map((d) => `./${d}`)]);
  }

  // Check Rust
  if (fs.existsSync(path.join(repoRoot, "Cargo.toml"))) {
    return plan(["cargo", "test"]);
  }

  return undefined;
}

/** Bentuk string siap tampil. Lihat `detectTestRunnerPlan` untuk eksekusi. */
export function detectTestRunner(
  repoRoot: string,
  testFiles: string[]
): string | undefined {
  return detectTestRunnerPlan(repoRoot, testFiles)?.command;
}

export function findAffectedTests(
  repoRoot: string,
  target: string
): TestSelectResult {
  const db = openDb(repoRoot);
  try {
    const allFiles = db.prepare(`SELECT id, path FROM files`).all() as {
      id: number;
      path: string;
    }[];
    const testFileMap = new Map<number, string>();
    const testPaths: string[] = [];

    for (const f of allFiles) {
      if (isTestPath(f.path)) {
        testFileMap.set(f.id, f.path);
        testPaths.push(f.path);
      }
    }

    const matchedTests = new Set<string>();

    // 1. Graph-based dependency search
    // Cari apakah target cocok dengan file atau nama simbol
    const targetFile = allFiles.find(
      (f) =>
        f.path === target ||
        f.path.endsWith("/" + target) ||
        f.path.endsWith("\\" + target)
    );

    const targetSymbols: { id: number; name: string; file_id: number }[] = [];

    if (targetFile) {
      const syms = db
        .prepare(`SELECT id, name, file_id FROM symbols WHERE file_id = ?`)
        .all(targetFile.id) as { id: number; name: string; file_id: number }[];
      targetSymbols.push(...syms);
    } else {
      const syms = db
        .prepare(`SELECT id, name, file_id FROM symbols WHERE name = ?`)
        .all(target) as { id: number; name: string; file_id: number }[];
      targetSymbols.push(...syms);
    }

    if (targetSymbols.length > 0) {
      const targetIds = targetSymbols.map((s) => s.id);
      const targetIdSet = new Set(targetIds);

      // 1a. Relasi langsung: edge yang bersumber dari test file/symbol menuju target symbol
      // atau edge dari target symbol menuju test symbol
      const inClause = targetIds.map(() => "?").join(",");
      const directRelRows = db
        .prepare(
          `SELECT r.source_id, r.target_id, s.file_id AS source_file_id
           FROM relationships r
           JOIN symbols s ON s.id = r.source_id
           WHERE r.target_id IN (${inClause})`
        )
        .all(...targetIds) as {
        source_id: number;
        target_id: number;
        source_file_id: number;
      }[];

      for (const r of directRelRows) {
        const testPath = testFileMap.get(r.source_file_id);
        if (testPath) matchedTests.add(testPath);
      }

      // 1b. 2-hop traversal: callers yang dipanggil oleh test
      const callerRows = db
        .prepare(
          `SELECT r.source_id AS intermediate_id
           FROM relationships r
           WHERE r.target_id IN (${inClause})`
        )
        .all(...targetIds) as { intermediate_id: number }[];

      if (callerRows.length > 0) {
        const intermediateIds = callerRows.map((c) => c.intermediate_id);
        const interClause = intermediateIds.map(() => "?").join(",");
        const indirectRows = db
          .prepare(
            `SELECT s.file_id AS source_file_id
             FROM relationships r
             JOIN symbols s ON s.id = r.source_id
             WHERE r.target_id IN (${interClause})`
          )
          .all(...intermediateIds) as { source_file_id: number }[];

        for (const r of indirectRows) {
          const testPath = testFileMap.get(r.source_file_id);
          if (testPath) matchedTests.add(testPath);
        }
      }
    }

    // 2. Fallback text search untuk melengkapi recall bila target tidak memiliki edge eksplisit
    const base = path.basename(target);
    const baseNoExt = base.replace(/\.[^./\\]+$/, "");
    const needles = new Set<string>(
      [target, base, baseNoExt].filter((s) => s.length > 0)
    );

    for (const rel of testPaths) {
      if (matchedTests.has(rel)) continue;
      let content: string;
      try {
        content = fs.readFileSync(path.join(repoRoot, ...rel.split("/")), "utf8");
      } catch {
        continue;
      }
      for (const n of needles) {
        if (content.includes(n)) {
          matchedTests.add(rel);
          break;
        }
      }
    }

    const testList = Array.from(matchedTests).sort();
    const runner = detectTestRunnerPlan(repoRoot, testList);

    return {
      target,
      tests: testList,
      runnerCommand: runner?.command,
      runnerArgv: runner?.argv,
    };
  } finally {
    db.close();
  }
}

export function cmdTestSelect(
  repoRoot: string,
  target: string,
  opts?: { run?: boolean; json?: boolean }
): void {
  const result = findAffectedTests(repoRoot, target);

  // Eksekusi harus mendahului emisi JSON. Sebelumnya `--run-tests --json`
  // return lebih dulu sehingga test tidak pernah jalan, tapi exit 0 — CI
  // mendapat JSON, nol eksekusi, dan dianggap lulus.
  let exitStatus: number | undefined;
  if (opts?.run && result.runnerArgv && result.runnerArgv.length > 0) {
    const [cmd, ...args] = result.runnerArgv;
    // `shell: false` — argv berasal dari `files.path` (input repo), bukan
    // tepercaya. `shell: true` dulu memungkinkan injeksi lewat nama file.
    if (!opts.json) console.log(`Executing: ${result.runnerCommand}`);
    const res = spawnSync(cmd, args, { cwd: repoRoot, stdio: "inherit", shell: false });
    if (res.error) {
      const msg = `Gagal menjalankan test runner: ${res.error.message}`;
      if (opts.json) console.error(msg);
      else console.log(msg);
      process.exitCode = 1;
      exitStatus = 1;
    } else {
      // `status === null` berarti process dibunuh signal — perlakukan gagal.
      exitStatus = res.status ?? 1;
      process.exitCode = exitStatus;
    }
  }

  if (opts?.json) {
    console.log(JSON.stringify({ ...result, exitStatus }, null, 2));
    return;
  }

  if (result.tests.length === 0) {
    console.log(`No tests reference or test "${target}".`);
    return;
  }

  console.log(`Affected tests for "${target}" (${result.tests.length} suites):`);
  for (const m of result.tests) {
    console.log(`  • ${m}`);
  }

  if (result.runnerCommand) {
    console.log(`\nRecommended runner command:`);
    console.log(`  $ ${result.runnerCommand}\n`);
  }
}
