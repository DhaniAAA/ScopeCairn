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

  const baseResult = opts.base ? changedFilesVsBase(repoRoot, opts.base) : null;
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
        // lebih jujur Says "tidak bisa ditentukan".
        scopeUndetermined = true;
        warnings.push(
          "Scope task tidak dapat dihitung — jalankan `scopecairn context` untuk task ini lebih dulu, atau perjelas `--task`."
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
  } finally {
    db.close();
  }

  const newCycleViolations = detectedCycles.filter((c) => c.involvesChangedFiles);

  let ok = true;
  if (protectedViolations.length > 0) ok = false;
  if (newCycleViolations.length > 0) ok = false;
  if (opts.strict && scopeViolations.length > 0) ok = false;
  if (dod && dodFailed(dod)) ok = false;
  if (baseResult?.baseInvalid) ok = false;

  return {
    ok,
    changedFiles: changed,
    protectedViolations,
    scopeViolations,
    cycles: detectedCycles,
    warnings,
    dod,
    scopeSource,
    scopeUndetermined: scopeUndetermined || undefined,
    baseInvalid: baseResult?.baseInvalid || undefined,
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
      const mark = opts.strict ? "[✗]" : "[!]";
      console.log(`${mark} Scope Boundary: ${opts.strict ? "FAILED" : "WARNING"}`);
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

  console.log("");
  if (result.ok) {
    console.log("Result: VERIFICATION PASSED ✓");
  } else {
    console.log("Result: VERIFICATION FAILED ✗");
    process.exitCode = 1;
  }
}
