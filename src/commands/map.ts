import type { DatabaseSync } from "node:sqlite";
import { openDb } from "../db.js";
import { logInvocation } from "../invocations.js";

const MAP_TYPES = `('function','class','interface','type','component','model','route','enum')`;

/** Satu baris per file: path + simbol paling banyak dipakai. Untuk dipilih agent sebagai anchor. */
export function buildMap(db: DatabaseSync, dir?: string, perFile = 4): string {
  const prefix = (dir ?? "").trim().replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
  const esc = prefix.replace(/[\\%_]/g, (c) => "\\" + c);
  const rows = db
    .prepare(
      `SELECT f.path AS file, s.name AS name,
              (SELECT COUNT(*) FROM relationships r WHERE r.target_id = s.id) AS n
       FROM symbols s JOIN files f ON f.id = s.file_id
       WHERE s.type IN ${MAP_TYPES} AND (? = '' OR f.path LIKE ? ESCAPE '\\')
       ORDER BY f.path, n DESC, s.name`
    )
    .all(prefix, `${esc}/%`) as { file: string; name: string; n: number }[];

  const byFile = new Map<string, string[]>();
  for (const r of rows) {
    const list = byFile.get(r.file) ?? [];
    if (list.length < perFile) list.push(r.name);
    byFile.set(r.file, list);
  }
  const byDir = new Map<string, string[]>();
  for (const [file, names] of byFile) {
    const d = file.includes("/") ? file.slice(0, file.lastIndexOf("/")) : ".";
    const list = byDir.get(d) ?? [];
    list.push(`- ${file.slice(d === "." ? 0 : d.length + 1)}: ${names.join(", ")}`);
    byDir.set(d, list);
  }
  const lines: string[] = [];
  for (const [d, list] of byDir) lines.push(`\n## ${d}/`, ...list);
  return (
    `# Code Map${prefix ? ` (${prefix}/)` : ""}\n` +
    `Pilih file/folder yang relevan, lalu: scopecairn context --anchor <path> "<task>"\n` +
    (lines.join("\n") || "\n(index kosong — jalankan `scopecairn scan`)") +
    "\n"
  );
}

export function cmdMap(repoRoot: string, dir?: string): void {
  const db = openDb(repoRoot);
  try {
    logInvocation(db, "map");
    console.log(buildMap(db, dir));
  } finally {
    db.close();
  }
}
