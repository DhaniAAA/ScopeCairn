import fs from "node:fs";
import path from "node:path";
import { dataDir } from "./db.js";

function decisionsPath(repoRoot: string): string {
  return path.join(dataDir(repoRoot), "decisions.md");
}

export function loadDecisions(repoRoot: string): string | null {
  try {
    return fs.readFileSync(decisionsPath(repoRoot), "utf8");
  } catch {
    return null;
  }
}

/** Entri keputusan (baris daftar `- ...`) tanpa header, urut sebagaimana ditulis. */
export function listDecisions(repoRoot: string): string[] {
  const raw = loadDecisions(repoRoot);
  if (!raw) return [];
  return raw
    .split("\n")
    .filter((l) => l.startsWith("- "))
    .map((l) => l.trimEnd());
}

export function appendDecision(repoRoot: string, text: string): void {
  // Keputusan selalu satu baris: newline mentah akan memecah daftar markdown
  // saat dibaca `context`, jadi rapikan dulu.
  const line = text.replace(/\s+/g, " ").trim();
  if (line.length === 0) throw new Error("teks keputusan kosong");
  const file = decisionsPath(repoRoot);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const date = new Date().toISOString().slice(0, 10);
  const entry = `- ${date}: ${line}\n`;
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, `# Decisions\n\n${entry}`, "utf8");
  } else {
    fs.appendFileSync(file, entry, "utf8");
  }
}
