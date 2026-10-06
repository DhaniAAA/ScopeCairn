import fs from "node:fs";
import path from "node:path";
import { openDb, dataDir } from "../db.js";
import { detectAdapters } from "../adapters/index.js";

export function cmdDashboard(repoRoot: string, opts: { out?: string }): void {
  const db = openDb(repoRoot);
  try {
    const files = (db.prepare(`SELECT COUNT(*) AS n FROM files`).get() as { n: number }).n;
    const symbols = (db.prepare(`SELECT COUNT(*) AS n FROM symbols`).get() as { n: number }).n;
    const rels = (db.prepare(`SELECT COUNT(*) AS n FROM relationships`).get() as { n: number }).n;

    const top = db
      .prepare(
        `SELECT s.name AS name, COUNT(r.target_id) AS n
         FROM relationships r JOIN symbols s ON s.id = r.target_id
         GROUP BY r.target_id ORDER BY n DESC LIMIT 20`
      )
      .all() as { name: string; n: number }[];

    let adapters: string[] = [];
    try {
      const paths = (db.prepare(`SELECT path FROM files`).all() as { path: string }[]).map((r) => r.path);
      adapters = detectAdapters(paths, repoRoot).map((a) => a.id);
    } catch {
      // ignore
    }

    let tasks: { description: string; complexity: string; created_at: string; completed_at: string | null }[] = [];
    try {
      tasks = db
        .prepare(
          `SELECT description, complexity, created_at, completed_at FROM tasks ORDER BY id DESC LIMIT 20`
        )
        .all() as typeof tasks;
    } catch {
      // pre-existing DB without tasks table
    }

    const esc = (s: string) =>
      s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

    const topRows = top.map((t) => `<tr><td>${esc(t.name)}</td><td>${t.n}</td></tr>`).join("\n") ||
      `<tr><td colspan="2">-</td></tr>`;
    const adapterList = adapters.length > 0 ? adapters.map(esc).join(", ") : "-";
    const taskRows =
      tasks
        .map(
          (t) =>
            `<tr><td>${esc(t.description)}</td><td>${esc(t.complexity)}</td><td>${esc(t.created_at)}</td><td>${t.completed_at ? esc(t.completed_at) : "-"}</td></tr>`
        )
        .join("\n") || `<tr><td colspan="4">-</td></tr>`;

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>ScopeCairn Dashboard</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 2rem; max-width: 900px; color: #222; }
  h1 { font-size: 1.5rem; }
  h2 { font-size: 1.1rem; margin-top: 2rem; }
  .cards { display: flex; gap: 1rem; }
  .card { border: 1px solid #ddd; border-radius: 8px; padding: 1rem 1.5rem; }
  .card .n { font-size: 1.8rem; font-weight: 700; }
  table { border-collapse: collapse; width: 100%; margin-top: 0.5rem; }
  th, td { border: 1px solid #ddd; padding: 0.4rem 0.8rem; text-align: left; }
  th { background: #f5f5f5; }
  tr:nth-child(even) { background: #fafafa; }
</style>
</head>
<body>
<h1>ScopeCairn Dashboard</h1>
<div class="cards">
  <div class="card"><div class="n">${files}</div>files</div>
  <div class="card"><div class="n">${symbols}</div>symbols</div>
  <div class="card"><div class="n">${rels}</div>relationships</div>
</div>
<h2>Top Symbols by Fan-in</h2>
<table><thead><tr><th>Symbol</th><th>Incoming</th></tr></thead><tbody>
${topRows}
</tbody></table>
<h2>Detected Adapters</h2>
<p>${adapterList}</p>
<h2>Recent Tasks</h2>
<table><thead><tr><th>Description</th><th>Complexity</th><th>Created</th><th>Completed</th></tr></thead><tbody>
${taskRows}
</tbody></table>
</body>
</html>
`;

    const dest = opts.out ?? path.join(dataDir(repoRoot), "dashboard.html");
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, html, "utf8");
    console.log(`Dashboard written → ${dest}`);
  } finally {
    db.close();
  }
}
