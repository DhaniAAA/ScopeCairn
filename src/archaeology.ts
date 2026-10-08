import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { dataDir } from "./db.js";

// ARCHAEOLOGY.md: artefak "mengapa kode seperti ini" — top author per file,
// bus factor, aktivitas churn. Deterministik, murni dari `git log` lokal,
// write-if-absent agar tidak menimpa editan tangan.
export function writeArchaeologyIfAbsent(repoRoot: string): boolean {
  const target = path.join(dataDir(repoRoot), "ARCHAEOLOGY.md");
  if (fs.existsSync(target)) return false;
  let log: string;
  try {
    log = execFileSync(
      "git",
      ["log", "--max-count=1000", "--name-only", "--pretty=format:@%H|%aN", "--", "."],
      { cwd: repoRoot, encoding: "utf8", timeout: 30000, stdio: ["ignore", "pipe", "ignore"] }
    );
  } catch {
    return false;
  }
  const perFile = new Map<string, Map<string, number>>();
  let author = "";
  for (const line of log.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    if (t.startsWith("@")) {
      author = t.slice(1).split("|")[1] ?? t.slice(1);
      continue;
    }
    if (!author) continue;
    if (!perFile.has(t)) perFile.set(t, new Map());
    const m = perFile.get(t)!;
    m.set(author, (m.get(author) ?? 0) + 1);
  }
  const rows = [...perFile.entries()]
    .map(([file, authors]) => {
      const total = [...authors.values()].reduce((a, b) => a + b, 0);
      const top = [...authors.entries()].sort((a, b) => b[1] - a[1])[0];
      return { file, total, authors: authors.size, topAuthor: top[0], topShare: top[1] / total };
    })
    .sort((a, b) => b.total - a.total)
    .slice(0, 20);
  if (rows.length === 0) return false;
  const lines = [
    "# Archaeology",
    "",
    "Generated from local git history. Re-delete this file to regenerate.",
    "",
    "| File | Commits | Authors (bus factor) | Top author | Top share |",
    "|---|---|---|---|---|",
    ...rows.map(
      (r) => `| ${r.file} | ${r.total} | ${r.authors} | ${r.topAuthor} | ${(r.topShare * 100).toFixed(0)}% |`
    ),
    "",
  ];
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, lines.join("\n"));
    return true;
  } catch {
    return false;
  }
}
