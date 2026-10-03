import { openDb } from "../db.js";
import { logInvocation } from "../invocations.js";
import { refreshIndex } from "../refresh.js";
import { retrieve } from "../retrieval/retrieve.js";
import { classify } from "../retrieval/classify.js";
import { buildContext } from "../retrieval/contextBuilder.js";
import { cmdOrientasi, looksLikeRepoPath } from "./orientasi.js";

export interface ContextOptions {
  escalate?: boolean;
  noRefresh?: boolean;
}

// Entry point utama agent (PRD §8.4): satu perintah, ScopeCairn yang
// memutuskan seberapa banyak dikembalikan (SIMPLE ringkas / COMPLEX penuh).
export function cmdContext(
  repoRoot: string,
  task: string,
  opts: ContextOptions = {}
): void {
  if (!opts.noRefresh) {
    const { stats, bulk } = refreshIndex(repoRoot);    if (bulk) {
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
    const cls = classify(result.ranked, faninOf);

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

    const built = buildContext(db, task, result, cls, {
      escalate: opts.escalate,
      repoRoot,
    });
    console.log(built.markdown);
  } finally {
    db.close();
  }
}
