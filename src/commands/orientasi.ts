import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { openDb } from "../db.js";
import { neighbors } from "../graph.js";

// Task berupa path (`./`, `src/`, `package.json`) bukan deskripsi kerja —
// jawab dengan orientasi: peta repo atau ringkasan file, bukan dead-end.
// Task seperti `UI/UX` mengandung slash tapi bukan path — hanya rute ke
// orientasi bila eksplisit (`./`, `/`, `../`) atau terbukti ada
// (path riil di disk / file terindex). Tanpa spasi adalah syarat tambahan
// agar kalimat deskriptif tak terbajak.
function isPathLike(task: string): boolean {
  const t = task.trim().replace(/^["']|["']$/g, "");
  return (
    t === "." ||
    t === "./" ||
    t === "/" ||
    t.startsWith("./") ||
    t.startsWith("../") ||
    t.startsWith("/") ||
    t.startsWith("~")
  );
}
export function looksLikeRepoPath(
  db: DatabaseSync,
  repoRoot: string,
  task: string
): boolean {
  const t = task.trim().replace(/^["']|["']$/g, "");
  if (/\s/.test(t)) return false;
  if (isPathLike(task)) return true;
  try {
    fs.statSync(path.resolve(repoRoot, t));
    return true;
  } catch {
    // bukan path fs — cek index
  }
  try {
    const esc = t.replace(/[\\%_]/g, (c) => "\\" + c);
    const row = db
      .prepare(`SELECT 1 AS ok FROM files WHERE path = ? OR path LIKE ? ESCAPE '\\' LIMIT 1`)
      .get(t, `%/${esc}`);
    return !!row;
  } catch {
    return false;
  }
}

function topCentral(db: DatabaseSync, limit = 10): { name: string; type: string; file: string; fanin: number }[] {
  try {
    return db
      .prepare(
        `SELECT s.name, s.type, f.path AS file, COUNT(*) AS fanin
         FROM relationships r
         JOIN symbols s ON s.id = r.target_id
         JOIN files f ON f.id = s.file_id
         WHERE s.type IN ('function','class','method','component','interface','type')
         GROUP BY r.target_id ORDER BY fanin DESC LIMIT ${limit}`
      )
      .all() as { name: string; type: string; file: string; fanin: number }[];
  } catch {
    return [];
  }
}

export function cmdOrientasi(repoRoot: string, task: string): void {
  const db = openDb(repoRoot);
  try {
    const files = (db.prepare(`SELECT COUNT(*) AS n FROM files`).get() as { n: number }).n;
    if (files === 0) {
      console.log("Index kosong. Jalankan `scopecairn scan` dulu.");
      return;
    }
    const byLang = db
      .prepare(`SELECT language, COUNT(*) AS n FROM files GROUP BY language ORDER BY n DESC`)
      .all() as { language: string; n: number }[];
    const symbols = (db.prepare(`SELECT COUNT(*) AS n FROM symbols`).get() as { n: number }).n;

    // Path spesifik ke file terindex?
    const t = task.trim().replace(/^["']|["']$/g, "");
    const abs = path.resolve(repoRoot, t);
    let rel: string | null = null;
    try {
      const stat = fs.statSync(abs);
      if (stat.isFile()) rel = path.relative(repoRoot, abs).split(path.sep).join("/");
    } catch {
      rel = null;
    }
    if (rel) {
      const row = db.prepare(`SELECT id FROM files WHERE path = ?`).get(rel) as
        | { id: number }
        | undefined;
      if (row) {
        const syms = db
          .prepare(`SELECT name, type FROM symbols WHERE file_id = ? AND type != 'file' LIMIT 20`)
          .all(row.id) as { name: string; type: string }[];
        const fileSym = db
          .prepare(`SELECT id FROM symbols WHERE file_id = ? AND type = 'file'`)
          .get(row.id) as { id: number } | undefined;
        const linked = new Set<string>();
        if (fileSym) {
          for (const e of neighbors(db, fileSym.id, 30)) {
            if (e.other.file !== rel) linked.add(e.other.file);
          }
        }
        console.log(
          `# Task Context (orientasi)\n\n## Task\n${task}\n\n` +
            `## File\n${rel}\n\n` +
            `## Simbol (${syms.length})\n${syms.map((s) => `- ${s.name} (${s.type})`).join("\n") || "-"}\n\n` +
            `## Terkait langsung\n${[...linked].slice(0, 10).map((f) => `- ${f}`).join("\n") || "-"}\n\n` +
            `Butuh konteks kerja? Jalankan \`scopecairn context "<deskripsi task>"\`.\n`
        );
        return;
      }
    }

    // Default: peta repo.
    const central = topCentral(db);
    console.log(
      `# Task Context (orientasi)\n\n## Task\n${task}\n\n` +
        `## Ringkasan index\n` +
        `- ${files} file (${byLang.map((l) => `${l.language} ${l.n}`).join(", ")})\n` +
        `- ${symbols} simbol\n\n` +
        `## Simbol paling dipakai\n` +
        `${central.map((c) => `- ${c.name} (${c.type}, ${c.file}) ← ${c.fanin}x`).join("\n") || "-"}\n\n` +
        `Mulai dari simbol di atas, atau jalankan \`scopecairn context "<deskripsi task>"\` untuk konteks kerja.\n`
    );
  } finally {
    db.close();
  }
}
