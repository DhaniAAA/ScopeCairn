import { openDb } from "../db.js";
import { logInvocation } from "../invocations.js";

// Fase 2 minimal: substring search over symbols (name/path/signature).
// Fase 3 replaces this with FTS5 symbol index + graph expansion + ranking.
export function cmdQuery(repoRoot: string, text: string): void {
  const db = openDb(repoRoot);
  try {
    logInvocation(db, "query");
    const rows = db
      .prepare(
        `SELECT s.name, s.type, s.signature, f.path AS file
         FROM symbols s JOIN files f ON f.id = s.file_id
         WHERE s.name LIKE ? OR f.path LIKE ? OR s.signature LIKE ?
         ORDER BY CASE WHEN s.name = ? THEN 0 WHEN s.name LIKE ? THEN 1 ELSE 2 END,
                  s.name LIMIT 30`
      )
      .all(`%${text}%`, `%${text}%`, `%${text}%`, text, `${text}%`) as {
      name: string;
      type: string;
      signature: string;
      file: string;
    }[];
    if (rows.length === 0) {
      console.log(`No matches for "${text}".`);
      return;
    }
    for (const r of rows) {
      console.log(`${r.name} (${r.type}) — ${r.file}${r.signature ? ` — ${r.signature.slice(0, 80)}` : ""}`);
    }
  } finally {
    db.close();
  }
}
