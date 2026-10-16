import { openDb } from "../db.js";
import { logInvocation } from "../invocations.js";
import { refreshIndex } from "../refresh.js";
import { retrieve } from "../retrieval/retrieve.js";
import { classify, type Classification } from "../retrieval/classify.js";
import {
  buildContext,
  buildContextPayload,
  resolveEffectiveMode,
  type AgentMode,
} from "../retrieval/contextBuilder.js";
import { cmdOrientasi, looksLikeRepoPath } from "./orientasi.js";
import { loadDecisions } from "../decisions.js";
import { loadProtectedPatterns } from "../scope/protected.js";
import { changedFilesVsHead } from "../retrieval/gitChanged.js";

export interface ContextOptions {
  escalate?: boolean;
  noRefresh?: boolean;
  mode?: AgentMode;
  maxTokens?: number;
  noHistory?: boolean;
  withDiff?: boolean;
  noRules?: boolean;
  knowledge?: boolean;
  json?: boolean;
}

/** Seksi markdown yang boleh dibuang saat --max-tokens — harus PERSIS sama
 *  dengan heading `## …` yang dirender contextBuilder (drift = prune bisu). */
export const PRUNE_SECTIONS = [
  "Analogi riwayat",
  "Critical hotspots",
  "Hotspot arsitektur",
  "Circular dependency warning",
  "Dependencies",
  "Kenapa (impor/call antar file relevan)",
  "Cara pakai",
  "Related Tests",
  "Project Rules",
  "Ringkasan",
] as const;

/** Klasifikasi sintetis untuk jalur tanpa kandidat (index kosong / tanpa seed). */
function emptyClassification(reason: string): Classification {
  return {
    complexity: "SIMPLE",
    estimatedFiles: 0,
    modules: [],
    reasons: [reason],
    highFanin: [],
    protectedHits: [],
  };
}

// Entry point utama agent (PRD §8.4): satu perintah, ScopeCairn yang
// memutuskan seberapa banyak dikembalikan (SIMPLE ringkas / COMPLEX penuh).
export async function cmdContext(
  repoRoot: string,
  task: string,
  opts: ContextOptions = {}
): Promise<void> {
  if (!opts.noRefresh) {
    const { stats, bulk } = await refreshIndex(repoRoot);
    if (bulk) {
      const note =
        `> Note: ${stats.inserted + stats.updated} file berubah ` +
        `(mis. git pull/ganti branch). Konteks tetap dibuat; ` +
        `jalankan \`scopecairn scan\` bila hasil terasa usang.\n`;
      // --json: stdout harus tetap satu envelope utuh → catatan ke stderr.
      (opts.json ? console.error : console.log)(note);
    }
  }

  const db = openDb(repoRoot);
  try {
    /** Envelope kosong — jalur tanpa kandidat memakai bentuk key yang sama. */
    const printEmptyEnvelope = (reason: "no_index" | "no_symbols", why: string): void => {
      const clsEmpty = emptyClassification(why);
      console.log(
        JSON.stringify(
          buildContextPayload({
            task,
            cls: clsEmpty,
            mode: resolveEffectiveMode(opts.mode ?? "NORMAL", clsEmpty, opts.knowledge),
            knowledge: opts.knowledge,
            empty: true,
            reason,
          }),
          null,
          2
        )
      );
    };
    const fileCount = (
      db.prepare(`SELECT COUNT(*) AS n FROM files`).get() as { n: number }
    ).n;
    if (fileCount === 0) {
      if (opts.json) {
        printEmptyEnvelope("no_index", "index kosong");
        return;
      }
      console.log("Index kosong. Jalankan `scopecairn scan` dulu.");
      return;
    }

    // Task berupa path (`./`, `src/db.ts`, ...) = minta orientasi:
    // deterministik, tanpa ranking. Baru ke retrieval bila bukan path.
    // (--json selalu lewat retrieval agar stdout tetap satu envelope JSON.)
    if (!opts.json && looksLikeRepoPath(db, repoRoot, task)) {
      logInvocation(db, "context");
      cmdOrientasi(repoRoot, task);
      return;
    }

    const result = retrieve(db, repoRoot, task);
    if (result.ranked.length === 0) {
      // Selalu aman dipanggil (prinsip 6): tanpa seed pun beri arahan SIMPLE,
      // bukan jalan buntu — agent lanjut dengan pencarian langsung.
      logInvocation(db, "context");
      if (opts.json) {
        printEmptyEnvelope("no_symbols", "tidak ada simbol cocok di index");
        return;
      }
      const title = opts.knowledge ? `# Task Context (Knowledge)` : `# Task Context`;
      console.log(
        `${title}\n\n## Task\n${task}\n\n## Complexity\n` +
          `SIMPLE (tidak ada simbol cocok di index)\n\n` +
          `Task sederhana. Gunakan pencarian langsung. ` +
          `Bila istilah domain tak cocok dengan nama kode, tambah alias di ` +
          `\`.scopecairn/glossary.yml\`.\n`
      );
      return;
    }

    const faninOf = (id: number): number => {
      const r = db
        .prepare(`SELECT COUNT(*) AS n FROM relationships WHERE target_id = ?`)
        .get(id) as { n: number };
      return r.n;
    };
    const cls = classify(result.ranked, faninOf, 0.15, loadProtectedPatterns(repoRoot));

    // Persist untuk compliance/recall Fase 6.
    const t = db
      .prepare(`INSERT INTO tasks(description, complexity) VALUES (?, ?)`)
      .run(task, opts.escalate ? "COMPLEX" : cls.complexity);
    const taskId = Number(t.lastInsertRowid);
    const insCtx = db.prepare(
      `INSERT INTO task_context(task_id, symbol_id, score, reason) VALUES (?, ?, ?, ?)`
    );
    for (const r of result.ranked.slice(0, 20)) {
      insCtx.run(taskId, r.id, r.score, r.reason);
    }
    logInvocation(db, "context", taskId);

    const mode = opts.mode ?? "NORMAL";
    // Cost-aware routing: konteks kecil → FAST implisit (hindari eskalasi
    // boros), kecuali mode knowledge yang justru butuh analog + simbol penuh.
    const effectiveMode = resolveEffectiveMode(mode, cls, Boolean(opts.knowledge));
    const escalate =
      opts.escalate === true || effectiveMode === "SAFE" || effectiveMode === "AUDIT";

    // FAST = konteks paling ramping: ranking dipotong, anotasi ekstra dilewati.
    if (effectiveMode === "FAST") {
      result.ranked = result.ranked.slice(0, 8);
    }

    const changed = changedFilesVsHead(repoRoot);
    if (changed.length > 0) {
      const note =
        `> Working tree: ${changed.length} file berubah vs HEAD (${changed
          .slice(0, 5)
          .join(", ")}${changed.length > 5 ? ", ..." : ""}).\n`;
      // --json: stdout harus tetap satu envelope utuh → catatan ke stderr.
      (opts.json ? console.error : console.log)(note);
    }

    const decisions = loadDecisions(repoRoot);

    // Analogi riwayat: aktif default pada COMPLEX, dilewati bila --no-history
    // atau mode FAST. Gagal lembut (repo tanpa git) → seksi disembunyikan.
    // (Commander memetakan --no-history ke { history: false }; terima dua bentuk.)
    const skipHistory =
      opts.noHistory === true || (opts as { history?: boolean }).history === false;
    let historyAnalogs: import("../retrieval/history/search.js").HistoryAnalog[] = [];
    const diffStats = new Map<string, string>();
    if (!skipHistory && effectiveMode !== "FAST") {
      try {
        const { historySearch } = await import("../retrieval/history/search.js");
        const seedFiles = [...new Set(result.ranked.filter((r) => r.score >= 0.15).map((r) => r.file))].slice(0, 20);
        historyAnalogs = historySearch(db, task, { seedFiles, limit: 3 });
        if (opts.withDiff) {
          const { execFileSync } = await import("node:child_process");
          for (const a of historyAnalogs) {
            try {
              const out = execFileSync("git", ["show", "--stat", "--oneline", a.sha], {
                cwd: repoRoot,
                encoding: "utf8",
                timeout: 8000,
                stdio: ["ignore", "pipe", "ignore"],
              });
              diffStats.set(a.shortSha, out.split("\n").filter(Boolean).slice(0, 12).join(" | ").slice(0, 500));
            } catch {
              // abaikan per analog
            }
          }
        }
      } catch {
        historyAnalogs = [];
      }
    }

    // (Commander memetakan --no-rules ke { rules: false }; terima dua bentuk.)
    const skipRules =
      opts.noRules === true || (opts as { rules?: boolean }).rules === false;
    let projectRules: import("../scope/agentsmd.js").ProjectRules | null = null;
    if (!skipRules) {
      try {
        const { loadProjectRules } = await import("../scope/agentsmd.js");
        projectRules = loadProjectRules(repoRoot);
      } catch {
        projectRules = null;
      }
    }

    const built = buildContext(db, task, result, cls, {
      escalate,
      repoRoot,
      history: historyAnalogs.length > 0 ? { analogs: historyAnalogs, diffStats } : undefined,
      projectRules,
      knowledge: opts.knowledge,
    });
    // F2 --json: envelope machine-readable untuk RAG/knowledge agent.
    // Default markdown tetap agar konsumen lama tidak pecah.
    if (opts.json) {
      const payload = buildContextPayload({
        task,
        cls,
        escalate,
        mode: effectiveMode,
        knowledge: opts.knowledge,
        built,
        ranked: result.ranked,
        analogs: historyAnalogs,
      });
      console.log(JSON.stringify(payload, null, 2));
      return;
    }
    let out = built.markdown;
    if (effectiveMode !== "NORMAL") {
      out += `\n\n## Mode\n${effectiveMode}\n`;
    }
    if (decisions) {
      out += `\n\n## Keputusan Arsitektur (.scopecairn/decisions.md)\n${decisions}\n`;
    }
    const maxTokens = opts.maxTokens;
    if (maxTokens && maxTokens > 0 && Math.ceil(out.length / 4) > maxTokens) {
      const parts = out.split(/\n(?=## )/);
      for (const sec of PRUNE_SECTIONS) {
        if (Math.ceil(parts.join("\n").length / 4) <= maxTokens) break;
        const i = parts.findIndex((p) => p.startsWith(`## ${sec}`));
        if (i >= 0) parts.splice(i, 1);
      }
      out = parts.join("\n");
      if (Math.ceil(out.length / 4) > maxTokens) out = out.slice(0, maxTokens * 4);
      out += `\n\n## Note\nOutput dipangkas agar muat --max-tokens ${maxTokens} (≈ ${maxTokens * 4} char).\n`;
    }
    console.log(out);
  } finally {
    db.close();
  }
}
