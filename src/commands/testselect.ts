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
}

export function detectTestRunner(
  repoRoot: string,
  testFiles: string[]
): string | undefined {
  if (testFiles.length === 0) return undefined;
  const pkgPath = path.join(repoRoot, "package.json");
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
      const testScript = (pkg.scripts && pkg.scripts.test) || "";
      if (testScript.includes("vitest")) {
        return `npx vitest run ${testFiles.join(" ")}`;
      }
      if (testScript.includes("jest")) {
        return `npx jest ${testFiles.join(" ")}`;
      }
      if (testScript.includes("tsx --test") || testScript.includes("node --test")) {
        return `npx tsx --test ${testFiles.join(" ")}`;
      }
      // General npm test with files passed
      return `npm test -- ${testFiles.join(" ")}`;
    } catch {
      // ignore
    }
  }

  // Check Python
  if (fs.existsSync(path.join(repoRoot, "pytest.ini")) || fs.existsSync(path.join(repoRoot, "pyproject.toml"))) {
    return `pytest ${testFiles.join(" ")}`;
  }

  // Check Go
  if (fs.existsSync(path.join(repoRoot, "go.mod"))) {
    const dirs = Array.from(new Set(testFiles.map((f) => path.dirname(f))));
    return `go test ${dirs.map((d) => `./${d}`).join(" ")}`;
  }

  // Check Rust
  if (fs.existsSync(path.join(repoRoot, "Cargo.toml"))) {
    return `cargo test`;
  }

  return undefined;
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
    const runnerCmd = detectTestRunner(repoRoot, testList);

    return {
      target,
      tests: testList,
      runnerCommand: runnerCmd,
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

  if (opts?.json) {
    console.log(JSON.stringify(result, null, 2));
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

    if (opts?.run) {
      console.log(`Executing tests...`);
      const parts = result.runnerCommand.split(" ");
      const cmd = parts[0];
      const args = parts.slice(1);
      const res = spawnSync(cmd, args, {
        cwd: repoRoot,
        stdio: "inherit",
        shell: true,
      });
      process.exitCode = res.status ?? 0;
    }
  }
}
