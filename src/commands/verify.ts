import { openDb } from "../db.js";
import { changedFilesVsBase, changedFilesVsHead } from "../retrieval/gitChanged.js";
import { loadProtectedPatterns, isProtected } from "../scope/protected.js";
import { computeTaskScope, loadPersistedScope } from "../scope/taskScope.js";
import { refreshIndex } from "../refresh.js";
import { skipRefresh } from "./opts.js";
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
import { recordVerifiedTask } from "../retrieval/verified.js";
import { runTestGate, type TestGateResult } from "../scope/testGate.js";

export interface VerifyOptions {
  task?: string;
  strict?: boolean;
  json?: boolean;
  noRefresh?: boolean;
  diff?: boolean;
  arch?: boolean;
  init?: boolean;
  dod?: boolean;
  /**
   * Base ref untuk deteksi perubahan (mis. `main`, `origin/main`, `HEAD~3`).
   * Tanpa ini hanya working tree vs HEAD yang dicek — perubahan yang sudah
   * di-commit tidak terlihat sama sekali.
   */
  base?: string;
  /** Aktifkan gerbang testing (deteksi test yang dilemahkan, coverage baris yang diubah, mutation Stryker opsional). */
  testGate?: boolean;
  /** Override ambang minimal coverage pada baris yang diubah (0..100, default dari config.yml = 80). */
  coverageThreshold?: number;
  /** Aktifkan pemeriksaan mutation test lewat Stryker pada file yang diubah (opsional karena lambat). */
  mutation?: boolean;
  /** Override ambang minimal mutation score Stryker (0..100, default dari config.yml = 60). */
  mutationThreshold?: number;
  /** Jalankan test runner (Vitest/Jest) dengan --coverage sebelum memeriksa coverage baris yang diubah. */
  runCoverage?: boolean;
  /** Jalankan Stryker secara langsung untuk file yang diubah. */
  runMutation?: boolean;
  /** Hitung PR risk agregat (protected/cycle/fan-in) vs `--base` (default `origin/main`) + SARIF. */
  prRisk?: boolean;
  /** Cetak SARIF sederhana (mem butuh `--pr-risk`). */
  sarif?: boolean;
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
  /** Hanya terisi bila `--test-gate` (atau opsi coverage/mutation) diberikan. */
  testGate?: TestGateResult;
  /**
   * Dari mana scope diambil: `persisted` = scope yang tersimpan dari
   * `context` (kontak yang sama dengan agent), `computed` = dihitung ulang
   * karena `context` belum pernah dijalankan untuk task ini.
   */
  scopeSource?: "persisted" | "computed";
  /** True bila scope tak bisa ditentukan → cek scope dilewati, bukan "lolos". */
  scopeUndetermined?: boolean;
  /** True bila `--base` dipakai tapi ref-nya tidak valid. */
  baseInvalid?: boolean;
  /** True bila hasil verifikasi berhasil dicatat ke pembelajaran closed-loop. */
  verifiedRecorded?: boolean;
  /** Hanya terisi bila `--pr-risk` diberikan. */
  prRisk?: PrRiskReport;
}

export type PrRiskLevel = "HIGH" | "MED" | "LOW";

export interface PrRiskFile {
  path: string;
  risk: PrRiskLevel;
  reasons: string[];
  fanIn: number;
  inCycle: boolean;
  protected: boolean;
}

export interface SarifRun {
  tool: { driver: { name: string; rules: Array<{ id: string; name: string }> } };
  results: Array<{
    ruleId: string;
    level: "error" | "warning" | "note";
    message: { text: string };
    locations: Array<{
      physicalLocation: {
        artifactLocation: { uri: string };
        region: { startLine: number };
      };
    }>;
  }>;
}

export interface SarifLog {
  $schema: string;
  version: "2.1.0";
  runs: SarifRun[];
}

export interface PrRiskReport {
  base: string;
  aggregate: PrRiskLevel;
  changedFiles: string[];
  files: PrRiskFile[];
  sarif: SarifLog;
  baseInvalid?: boolean;
}

const RISK_ORDER: Record<PrRiskLevel, number> = { LOW: 0, MED: 1, HIGH: 2 };

function buildPrRiskSarif(files: PrRiskFile[]): SarifLog {
  const levelOf: Record<PrRiskLevel, "error" | "warning" | "note"> = {
    HIGH: "error",
    MED: "warning",
    LOW: "note",
  };
  return {
    $schema: "https://json.schemastore.org/sarif-2.1.0.json",
    version: "2.1.0",
    runs: [
      {
        tool: {
          driver: {
            name: "scopecairn",
            rules: [
              { id: "pr-risk/HIGH", name: "High PR risk" },
              { id: "pr-risk/MED", name: "Medium PR risk" },
              { id: "pr-risk/LOW", name: "Low PR risk" },
            ],
          },
        },
        results: files.map((f) => ({
          ruleId: `pr-risk/${f.risk}`,
          level: levelOf[f.risk],
          message: { text: `PR risk ${f.risk} (${f.reasons.join("; ")})` },
          locations: [
            {
              physicalLocation: {
                artifactLocation: { uri: f.path },
                region: { startLine: 1 },
              },
            },
          ],
        })),
      },
    ],
  };
}

/**
 * Agregat PR risk per file (reuse logika risk `impact`: protected / cycle /
 * fan-in). Tak melempar — skema lama menghasilkan LOW + alasan "tak terhitung".
 */
export function computePrRisk(
  db: ReturnType<typeof openDb>,
  repoRoot: string,
  changed: string[],
  base: string,
  patterns: ReturnType<typeof loadProtectedPatterns>,
  baseInvalid = false
): PrRiskReport {
  const cycleFiles = new Set<string>();
  try {
    const cycRows = db.prepare(`SELECT nodes_json AS js FROM cycles`).all() as { js: string }[];
    for (const c of cycRows) {
      try {
        const nodes = JSON.parse(c.js) as number[];
        for (const id of nodes) {
          const row = db
            .prepare(
              `SELECT f.path AS p FROM symbols s JOIN files f ON f.id = s.file_id WHERE s.id = ?`
            )
            .get(id) as { p: string } | undefined;
          if (row) cycleFiles.add(row.p.replace(/\\/g, "/"));
        }
      } catch {
        // abaikan cycle korup
      }
    }
  } catch {
    // tabel cycles tak ada di skema lama — abaikan
  }

  const files: PrRiskFile[] = [];
  for (const f of changed) {
    const reasons: string[] = [];
    let risk: PrRiskLevel = "LOW";
    const isProtectedFile = isProtected(f, patterns);
    if (isProtectedFile) {
      risk = "HIGH";
      reasons.push(`file Protected (${f})`);
    }
    const inCycle = cycleFiles.has(f);
    if (inCycle) {
      risk = "HIGH";
      reasons.push("file di dalam dependency cycle");
    }
    let fanIn = 0;
    try {
      const r = db
        .prepare(
          `SELECT COUNT(*) AS n FROM relationships r
           JOIN symbols t ON t.id = r.target_id
           JOIN files ff ON ff.id = t.file_id
           WHERE ff.path = ? AND r.relationship_type IN ('CALLS','IMPORTS')`
        )
        .get(f) as { n: number };
      fanIn = r.n;
    } catch {
      // abaikan
    }
    if (fanIn >= 10) {
      risk = "HIGH";
      reasons.push(`fan-in ${fanIn}`);
    } else if (fanIn >= 3) {
      if (risk === "LOW") risk = "MED";
      reasons.push(`fan-in ${fanIn}`);
    }
    if (reasons.length === 0) reasons.push(`fan-in ${fanIn}`);
    files.push({ path: f, risk, reasons, fanIn, inCycle, protected: isProtectedFile });
  }

  let aggregate: PrRiskLevel = "LOW";
  for (const f of files) {
    if (RISK_ORDER[f.risk] > RISK_ORDER[aggregate]) aggregate = f.risk;
  }

  return {
    base,
    aggregate,
    changedFiles: changed,
    files,
    sarif: buildPrRiskSarif(files),
    ...(baseInvalid ? { baseInvalid: true } : {}),
  };
}

export async function runVerify(
  repoRoot: string,
  opts: VerifyOptions = {}
): Promise<VerifyResult> {
  let indexRefreshed = false;
  if (!skipRefresh(opts)) {
    try {
      await refreshIndex(repoRoot);
      indexRefreshed = true;
    } catch {
      // index refresh best-effort
    }
  }

  const effectiveBase = opts.base ?? (opts.prRisk ? "origin/main" : undefined);
  const baseResult = effectiveBase ? changedFilesVsBase(repoRoot, effectiveBase) : null;
  const changed = (
    baseResult ? baseResult.files : changedFilesVsHead(repoRoot)
  ).map((p) => p.replace(/\\/g, "/"));
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
  let scopeSource: "persisted" | "computed" | undefined;
  let scopeUndetermined = false;
  let dod: DodCheck[] | undefined;
  let persistedTaskId: number | undefined;
  let verifiedRecorded = false;

  // Base ref tak valid → hasil tak bisa dipercaya. GAGAL, jangan lolos
  // diam-diam: "0 file berubah" karena ref salah sama dengan false pass.
  if (baseResult?.baseInvalid) {
    warnings.push(
      `Base ref "${baseResult.base}" tidak valid — perubahan tidak bisa dibandingkan. Cek nama branch/ref.`
    );
  }

  try {
    logInvocation(db, "verify");

    // 1. Task Scope check (if task description is supplied)
    if (scopeChecked && opts.task) {
      // Prioritas: scope yang PERSIS dirender ke agent (disimpan saat
      // `context`). Kalau belum ada, hitung ulang lewat jalur yang sama
      // dengan `context` — bukan jalur terpisah yang bisa menyimpang.
      const persisted = loadPersistedScope(db, opts.task);
      persistedTaskId = persisted?.taskId;
      const scope = persisted
        ? persisted.scope
        : await computeTaskScope(db, repoRoot, opts.task);
      scopeSource = persisted ? "persisted" : "computed";

      const allowed = new Set(
        [...scope.required, ...scope.optional].map((p) => p.replace(/\\/g, "/"))
      );
      if (allowed.size === 0) {
        // Scope kosong tak bisa dipakai menilai apa pun. Menandainya sebagai
        // "semua file di luar scope" menghasilkan false positive total —
        // lebih jujur mengatakan "tidak bisa ditentukan".
        scopeUndetermined = true;
        warnings.push(
          persisted
            ? "Scope task kosong (tidak ada simbol terindeks yang cocok). Periksa deskripsi task atau ubah file secara bebas."
            : "Scope task tidak dapat dihitung — jalankan `scopecairn context` untuk task ini lebih dulu, atau perjelas `--task`."
        );
      } else {
        for (const f of changed) {
          if (!allowed.has(f)) {
            scopeViolations.push(f);
          }
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
        scopeUndetermined,
        affectedTests: collectAffectedTests(db, changed),
        indexRefreshed,
      });
    }

    const shouldRunTestGate = Boolean(
      opts.testGate ||
        opts.mutation ||
        opts.coverageThreshold !== undefined ||
        opts.mutationThreshold !== undefined ||
        opts.runCoverage ||
        opts.runMutation
    );
    const testGate = shouldRunTestGate
      ? runTestGate(repoRoot, changed, {
          base: effectiveBase,
          coverageThreshold: opts.coverageThreshold,
          mutation: opts.mutation,
          mutationThreshold: opts.mutationThreshold,
          runCoverage: opts.runCoverage,
          runMutation: opts.runMutation,
        })
      : undefined;

    const prRisk = opts.prRisk
      ? computePrRisk(db, repoRoot, changed, effectiveBase ?? "origin/main", patterns, Boolean(baseResult?.baseInvalid))
      : undefined;

    const newCycleViolations = detectedCycles.filter((c) => c.involvesChangedFiles);

    let ok = true;
    if (protectedViolations.length > 0) ok = false;
    if (newCycleViolations.length > 0) ok = false;
    const isStrict = opts.strict !== false;
    if (isStrict && scopeViolations.length > 0) ok = false;
    if (dod && dodFailed(dod)) ok = false;
    if (testGate && !testGate.ok) ok = false;
    if (baseResult?.baseInvalid) ok = false;

    if (ok && scopeChecked && opts.task && changed.length > 0 && !scopeUndetermined) {
      recordVerifiedTask(db, opts.task, changed, persistedTaskId);
      verifiedRecorded = true;
    }

    return {
      ok,
      changedFiles: changed,
      protectedViolations,
      scopeViolations,
      cycles: detectedCycles,
      warnings,
      dod,
      testGate,
      prRisk,
      scopeSource,
      scopeUndetermined: scopeUndetermined || undefined,
      baseInvalid: baseResult?.baseInvalid || undefined,
      verifiedRecorded: verifiedRecorded || undefined,
    };
  } finally {
    db.close();
  }
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

  if (opts.sarif && result.prRisk) {
    console.log(JSON.stringify(result.prRisk.sarif, null, 2));
    return;
  }

  if (opts.json) {
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exitCode = 1;
    return;
  }

  console.log("# ScopeCairn Verification Report\n");
  console.log(
    opts.base
      ? `Changed files vs base "${opts.base}" (committed + working tree): ${result.changedFiles.length}`
      : `Changed files in working tree: ${result.changedFiles.length}`
  );
  if (result.baseInvalid) {
    console.log("[✗] Base ref invalid — hasil perbandingan tidak valid");
  }
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
    if (result.scopeUndetermined) {
      console.log("[?] Scope Boundary: SKIPPED (scope could not be determined)");
      console.log("    Jalankan `scopecairn context \"<task>\"` lebih dulu agar scope tersimpan,");
      console.log("    lalu ulangi `scopecairn verify --task \"<task>\"`.");
    } else if (result.scopeViolations.length === 0) {
      const src =
        result.scopeSource === "persisted"
          ? " (scope dari context)"
          : result.scopeSource === "computed"
            ? " (scope dihitung ulang — context belum dijalankan)"
            : "";
      console.log(`[✓] Scope Boundary: PASSED (All modifications within task scope)${src}`);
    } else {
      const isStrict = opts.strict !== false;
      const mark = isStrict ? "[✗]" : "[!]";
      console.log(`${mark} Scope Boundary: ${isStrict ? "FAILED" : "WARNING"}`);
      console.log("    Modifications outside task scope (scope creep):");
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

  if (result.testGate) {
    const tg = result.testGate;
    console.log("\n## Testing Gate");
    console.log(`Runner detected: ${tg.runner}`);

    if (tg.weakenedTests.length === 0) {
      console.log("[✓] Test Integrity: PASSED (No weakened tests detected)");
    } else {
      console.log(`[✗] Test Integrity: FAILED (${tg.weakenedTests.length} weakened test finding(s))`);
      for (const w of tg.weakenedTests) {
        console.log(`      • [${w.kind}] ${w.file}: ${w.detail}`);
        console.log(`        ${w.evidence}`);
      }
    }

    if (tg.coverage.status === "pass") {
      console.log(
        `[✓] Changed Lines Coverage: PASSED (${tg.coverage.pct}% >= ${tg.coverage.threshold}%, ${tg.coverage.coveredLines}/${tg.coverage.totalLines} lines)`
      );
    } else if (tg.coverage.status === "fail") {
      console.log(
        `[✗] Changed Lines Coverage: FAILED (${tg.coverage.pct}% < ${tg.coverage.threshold}%, ${tg.coverage.coveredLines}/${tg.coverage.totalLines} lines)`
      );
      for (const f of tg.coverage.files) {
        if (f.uncoveredLines.length > 0) {
          console.log(
            `      • ${f.file}: ${f.pct}% (uncovered lines: ${f.uncoveredLines.join(", ")})`
          );
        }
      }
    } else {
      console.log(`[?] Changed Lines Coverage: SKIPPED — ${tg.coverage.reason ?? ""}`);
    }

    if (tg.mutation.status === "pass") {
      console.log(
        `[✓] Stryker Mutation Gate: PASSED (${tg.mutation.score}% >= ${tg.mutation.threshold}%)`
      );
    } else if (tg.mutation.status === "fail") {
      console.log(
        `[✗] Stryker Mutation Gate: FAILED (${tg.mutation.score}% < ${tg.mutation.threshold}%)`
      );
      for (const f of tg.mutation.files) {
        console.log(
          `      • ${f.file}: ${f.score}% (killed=${f.killed}, survived=${f.survived}, noCoverage=${f.noCoverage})`
        );
      }
    } else {
      console.log(`[?] Stryker Mutation Gate: SKIPPED — ${tg.mutation.reason ?? ""}`);
    }

    console.log(`\n(!) ${tg.limitationNote}`);
  }

  if (result.prRisk) {
    const pr = result.prRisk;
    console.log("\n## PR Risk");
    console.log(`Base: ${pr.base} (changed: ${pr.changedFiles.length}) — Aggregate: ${pr.aggregate}`);
    const mark = pr.aggregate === "HIGH" ? "[✗]" : pr.aggregate === "MED" ? "[!]" : "[✓]";
    console.log(`${mark} Aggregate risk: ${pr.aggregate}`);
    for (const f of pr.files) {
      console.log(`      • [${f.risk}] ${f.path} (fan-in ${f.fanIn}${f.inCycle ? ", cycle" : ""}${f.protected ? ", protected" : ""}) — ${f.reasons.join("; ")}`);
    }
  }

  console.log("");
  if (result.ok) {
    console.log("Result: VERIFICATION PASSED ✓");
    if (result.verifiedRecorded) {
      console.log(`[✓] Closed-loop Learning: Recorded ${result.changedFiles.length} verified files for task.`);
    }
  } else {
    console.log("Result: VERIFICATION FAILED ✗");
    process.exitCode = 1;
  }
}
