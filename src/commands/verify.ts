import { openDb } from "../db.js";
import { changedFilesVsHead } from "../retrieval/gitChanged.js";
import { loadProtectedPatterns, isProtected } from "../scope/protected.js";
import { refreshIndex } from "../refresh.js";
import { retrieve } from "../retrieval/retrieve.js";
import { classify } from "../retrieval/classify.js";
import { refreshCycles, getCycles, describeCycle } from "../graph/cycles.js";
import { logInvocation } from "../invocations.js";
import {
  collectAffectedTests,
  dodFailed,
  evaluateDod,
  renderDod,
  type DodCheck,
} from "../scope/dod.js";
import { cmdDiff } from "./diff.js";
import { cmdArchCheck } from "./archcheck.js";

export interface VerifyOptions {
  task?: string;
  strict?: boolean;
  json?: boolean;
  noRefresh?: boolean;
  diff?: boolean;
  arch?: boolean;
  init?: boolean;
  dod?: boolean;
}

export interface VerifyResult {
  ok: boolean;
  changedFiles: string[];
  protectedViolations: string[];
  scopeViolations: string[];
  cycles: {
    hash: string;
    description: string;
    involvesChangedFiles: boolean;
  }[];
  warnings: string[];
  /** Hanya terisi bila `--dod` diberikan. */
  dod?: DodCheck[];
}

export async function runVerify(
  repoRoot: string,
  opts: VerifyOptions = {}
): Promise<VerifyResult> {
  let indexRefreshed = false;
  if (!opts.noRefresh) {
    try {
      await refreshIndex(repoRoot);
      indexRefreshed = true;
    } catch {
      // index refresh best-effort
    }
  }

  const changed = changedFilesVsHead(repoRoot).map((p) => p.replace(/\\/g, "/"));
  const patterns = loadProtectedPatterns(repoRoot);
  const protectedViolations: string[] = [];

  for (const f of changed) {
    if (isProtected(f, patterns)) {
      protectedViolations.push(f);
    }
  }

  const db = openDb(repoRoot);
  const scopeViolations: string[] = [];
  const warnings: string[] = [];
  const detectedCycles: VerifyResult["cycles"] = [];
  const scopeChecked = Boolean(opts.task && opts.task.trim().length > 0);
  let dod: DodCheck[] | undefined;

  try {
    logInvocation(db, "verify");

    // 1. Task Scope check (if task description is supplied)
    if (scopeChecked && opts.task) {
      const retrieval = retrieve(db, repoRoot, opts.task);
      const faninOf = (id: number): number => {
        const r = db
          .prepare(`SELECT COUNT(*) AS n FROM relationships WHERE target_id = ?`)
          .get(id) as { n: number };
        return r.n;
      };
      const cls = classify(retrieval.ranked, faninOf, 0.15, patterns);
      const { buildContext } = await import("../retrieval/contextBuilder.js");
      const { computeScope } = await import("../scope/scope.js");
      const built = buildContext(db, opts.task, retrieval, cls, { repoRoot });
      const scope = computeScope(built.high, built.medium, built.tests, patterns);
      const allowed = new Set([
        ...scope.required,
        ...scope.optional,
      ].map((p) => p.replace(/\\/g, "/")));

      for (const f of changed) {
        // Files created as tests or documentation are tolerated as optional,
        // but core code files outside scope are marked as scope violations.
        if (!allowed.has(f)) {
          scopeViolations.push(f);
        }
      }
    }

    // 2. Circular dependency check
    refreshCycles(db);
    const cycles = getCycles(db, 20);

    // Dapatkan set file yang ada di changed
    const changedSet = new Set(changed);

    for (const c of cycles) {
      const desc = describeCycle(db, c, 10);
      let involvesChanged = false;
      for (const nodeId of c.nodeIds) {
        const row = db
          .prepare(
            `SELECT f.path AS path FROM symbols s JOIN files f ON f.id = s.file_id WHERE s.id = ?`
          )
          .get(nodeId) as { path: string } | undefined;
        if (row && changedSet.has(row.path.replace(/\\/g, "/"))) {
          involvesChanged = true;
          break;
        }
      }
      detectedCycles.push({
        hash: c.hash,
        description: desc,
        involvesChangedFiles: involvesChanged,
      });
    }

    // 3. CALLS_API: route yang diubah tapi kliennya tak ada di daftar Required.
    try {
      const hasCallsApi = (
        db.prepare(`SELECT COUNT(*) AS n FROM relationships WHERE relationship_type = 'CALLS_API'`).get() as { n: number }
      ).n;
      if (hasCallsApi > 0 && changed.length > 0) {
        const ph = changed.map(() => "?").join(",");
        const changedRoutes = db
          .prepare(
            `SELECT s.id AS id, s.name AS name FROM symbols s
             JOIN files f ON f.id = s.file_id
             WHERE s.type = 'route' AND f.path IN (${ph})`
          )
          .all(...changed) as { id: number; name: string }[];
        for (const r of changedRoutes.slice(0, 20)) {
          const clients = db
            .prepare(
              `SELECT DISTINCT f.path AS p FROM relationships rel
               JOIN symbols s ON s.id = rel.source_id
               JOIN files f ON f.id = s.file_id
               WHERE rel.target_id = ? AND rel.relationship_type = 'CALLS_API' LIMIT 10`
            )
            .all(r.id) as { p: string }[];
          const outside = clients
            .map((c) => c.p.replace(/\\/g, "/"))
            .filter((p) => !changedSet.has(p));
          for (const p of outside.slice(0, 5)) {
            warnings.push(`route ${r.name} punya klien ${p} yang tidak ada di daftar Required`);
          }
        }
      }
    } catch {
      // skema lama — abaikan
    }

    // 4. Definition of Done (--dod): nilai apa yang bisa dinilai mesin,
    // sisanya ditandai `manual` — tidak pernah diklaim lulus.
    if (opts.dod) {
      dod = evaluateDod({
        changedFiles: changed,
        scopeChecked,
        scopeViolations,
        affectedTests: collectAffectedTests(db, changed),
        indexRefreshed,
      });
    }
  } finally {
    db.close();
  }

  const newCycleViolations = detectedCycles.filter((c) => c.involvesChangedFiles);

  let ok = true;
  if (protectedViolations.length > 0) ok = false;
  if (newCycleViolations.length > 0) ok = false;
  if (opts.strict && scopeViolations.length > 0) ok = false;
  if (dod && dodFailed(dod)) ok = false;

  return {
    ok,
    changedFiles: changed,
    protectedViolations,
    scopeViolations,
    cycles: detectedCycles,
    warnings,
    dod,
  };
}

export async function cmdVerify(
  repoRoot: string,
  opts: VerifyOptions = {}
): Promise<void> {
  if (opts.diff) {
    cmdDiff(repoRoot, { json: opts.json });
    return;
  }
  if (opts.arch) {
    cmdArchCheck(repoRoot, { init: opts.init, json: opts.json });
    return;
  }

  const result = await runVerify(repoRoot, opts);

  if (opts.json) {
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exitCode = 1;
    return;
  }

  console.log("# ScopeCairn Verification Report\n");
  console.log(`Changed files in working tree: ${result.changedFiles.length}`);
  if (result.changedFiles.length > 0) {
    for (const f of result.changedFiles) {
      console.log(`  - ${f}`);
    }
  }
  console.log("");

  // Protected check
  if (result.protectedViolations.length === 0) {
    console.log("[✓] Protected Files: PASSED (No protected files modified)");
  } else {
    console.log("[✗] Protected Files: FAILED");
    console.log("    Protected files modified without explicit consent:");
    for (const f of result.protectedViolations) {
      console.log(`      • ${f}`);
    }
  }

  // Scope check
  if (opts.task) {
    if (result.scopeViolations.length === 0) {
      console.log("[✓] Scope Boundary: PASSED (All modifications within task scope)");
    } else {
      const mark = opts.strict ? "[✗]" : "[!]";
      console.log(`${mark} Scope Boundary: ${opts.strict ? "FAILED" : "WARNING"}`);
      console.log("    Modifications outside predicted task scope (scope creep):");
      for (const f of result.scopeViolations) {
        console.log(`      • ${f}`);
      }
    }
  }

  // Cycles check
  const newCycles = result.cycles.filter((c) => c.involvesChangedFiles);
  if (newCycles.length === 0) {
    console.log("[✓] Circular Dependencies: PASSED (No new cycles introduced)");
  } else {
    console.log("[✗] Circular Dependencies: FAILED");
    console.log("    Changes introduced or participate in circular dependency cycles:");
    for (const c of newCycles) {
      console.log(`      • ${c.description}`);
    }
  }

  if (result.cycles.length > newCycles.length) {
    const existing = result.cycles.filter((c) => !c.involvesChangedFiles);
    console.log(`\n(!) Notice: ${existing.length} pre-existing cycles exist in repo.`);
  }

  if (result.warnings.length > 0) {
    console.log(`\n[!] API clients (CALLS_API):`);
    for (const w of result.warnings.slice(0, 10)) {
      console.log(`      • ${w}`);
    }
  }

  if (result.dod) {
    console.log("");
    console.log(renderDod(result.dod));
  }

  console.log("");
  if (result.ok) {
    console.log("Result: VERIFICATION PASSED ✓");
  } else {
    console.log("Result: VERIFICATION FAILED ✗");
    process.exitCode = 1;
  }
}
