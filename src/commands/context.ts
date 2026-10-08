import { openDb } from "../db.js";
import { logInvocation } from "../invocations.js";
import { refreshIndex } from "../refresh.js";
import { retrieve } from "../retrieval/retrieve.js";
import { classify } from "../retrieval/classify.js";
import { buildContext } from "../retrieval/contextBuilder.js";
import { cmdOrientasi, looksLikeRepoPath } from "./orientasi.js";
import { loadDecisions } from "../decisions.js";
import { loadProtectedPatterns } from "../scope/protected.js";
import { changedFilesVsHead } from "../retrieval/gitChanged.js";

export interface ContextOptions {
  escalate?: boolean;
  noRefresh?: boolean;
  mode?: "NORMAL" | "FAST" | "SAFE" | "AUDIT";
  maxTokens?: number;
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
      console.log(
        `> Note: ${stats.inserted + stats.updated} file berubah ` +
          `(mis. git pull/ganti branch). Konteks tetap dibuat; ` +
          `jalankan \`scopecairn scan\` bila hasil terasa usang.\n`
      );
    }
  }

  const db = openDb(repoRoot);
  try {
    const fileCount = (
      db.prepare(`SELECT COUNT(*) AS n FROM files`).get() as { n: number }
    ).n;
    if (fileCount === 0) {
      console.log("Index kosong. Jalankan `scopecairn scan` dulu.");
      return;
    }

    // Task berupa path (`./`, `src/db.ts`, ...) = minta orientasi:
    // deterministik, tanpa ranking. Baru ke retrieval bila bukan path.
    if (looksLikeRepoPath(db, repoRoot, task)) {
      logInvocation(db, "context");
      cmdOrientasi(repoRoot, task);
      return;
    }

    const result = retrieve(db, repoRoot, task);
    if (result.ranked.length === 0) {
      // Selalu aman dipanggil (prinsip 6): tanpa seed pun beri arahan SIMPLE,
      // bukan jalan buntu — agent lanjut dengan pencarian langsung.
      logInvocation(db, "context");
      console.log(
        `# Task Context\n\n## Task\n${task}\n\n## Complexity\n` +
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
    // Cost-aware routing: konteks kecil → FAST implisit (hindari eskalasi boros).
    const effectiveMode =
      mode === "NORMAL" && cls.complexity === "SIMPLE" && cls.estimatedFiles <= 1
        ? "FAST"
        : mode;
    const escalate =
      opts.escalate === true ||
      effectiveMode === "SAFE" ||
      effectiveMode === "AUDIT" ||
      mode === "SAFE" ||
      mode === "AUDIT";

    // FAST = konteks paling ramping: ranking dipotong, anotasi ekstra dilewati.
    if (effectiveMode === "FAST") {
      result.ranked = result.ranked.slice(0, 8);
    }

    const changed = changedFilesVsHead(repoRoot);
    if (changed.length > 0) {
      console.log(
        `> Working tree: ${changed.length} file berubah vs HEAD (${changed
          .slice(0, 5)
          .join(", ")}${changed.length > 5 ? ", ..." : ""}).\n`
      );
    }

    const decisions = loadDecisions(repoRoot);

    const built = buildContext(db, task, result, cls, {
      escalate,
      repoRoot,
    });
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
      for (const sec of ["Critical hotspots", "Circular dependency warning", "Dependencies", "Related Tests"]) {
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
