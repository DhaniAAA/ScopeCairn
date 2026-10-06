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

export function appendDecision(repoRoot: string, text: string): void {
  const file = decisionsPath(repoRoot);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const date = new Date().toISOString().slice(0, 10);
  const line = `- ${date}: ${text}\n`;
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, `# Decisions\n\n${line}`, "utf8");
  } else {
    fs.appendFileSync(file, line, "utf8");
  }
}
