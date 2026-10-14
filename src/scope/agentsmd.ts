// Project Rules: baca AGENTS.md proyek agar agent memahami konvensi
// proyek (bahasa, workflow, batasan) dari output `context`.
// Read-only terhadap source; tak pernah throw (return null bila tak ada).

import fs from "node:fs";
import path from "node:path";

const CANDIDATES = ["AGENTS.md", "agents.md"];

/** Anggaran default isi AGENTS.md yang disuntik ke context (~1000 token). */
export const PROJECT_RULES_MAX_CHARS = 4000;

export interface ProjectRules {
  /** Path relatif, mis. `AGENTS.md`. */
  path: string;
  content: string;
  truncated: boolean;
}

export function findAgentsMd(repoRoot: string): string | null {
  for (const name of CANDIDATES) {
    try {
      if (fs.statSync(path.join(repoRoot, name)).isFile()) return name;
    } catch {
      // lanjut ke kandidat berikutnya
    }
  }
  return null;
}

export function loadProjectRules(
  repoRoot: string,
  maxChars = PROJECT_RULES_MAX_CHARS
): ProjectRules | null {
  if (typeof maxChars === "number" && maxChars <= 0) return null;
  const rel = findAgentsMd(repoRoot);
  if (!rel) return null;
  const cap = Math.max(
    500,
    Number.isFinite(maxChars) ? Math.floor(maxChars) : PROJECT_RULES_MAX_CHARS
  );
  const fullPath = path.join(repoRoot, rel);
  let text: string;
  let fileExceedsCap = false;
  try {
    const stat = fs.statSync(fullPath);
    const bytesToRead = Math.min(stat.size, cap * 4);
    fileExceedsCap = stat.size > bytesToRead;
    const fd = fs.openSync(fullPath, "r");
    try {
      const buf = Buffer.alloc(bytesToRead);
      const bytesRead = fs.readSync(fd, buf, 0, bytesToRead, 0);
      text = buf.subarray(0, bytesRead).toString("utf8");
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
  text = text.replace(/\r\n/g, "\n").trim();
  if (!text) return null;
  if (fileExceedsCap || text.length > cap) {
    return { path: rel, content: text.slice(0, cap).trimEnd(), truncated: true };
  }
  return { path: rel, content: text, truncated: false };
}

/**
 * Turunkan tingkat heading Markdown (# -> ###, ## -> ####) agar bersarang
 * rapi di bawah seksi ## Project Rules dan tidak memecah delimiter context.
 */
export function demoteHeadings(markdown: string): string {
  let inCodeBlock = false;
  return markdown
    .split("\n")
    .map((line) => {
      const trimmed = line.trimStart();
      if (trimmed.startsWith("```") || trimmed.startsWith("~~~")) {
        inCodeBlock = !inCodeBlock;
        return line;
      }
      if (!inCodeBlock && /^#{1,6}\s/.test(line)) {
        return line.replace(/^(#{1,6})\s/, (_, hashes: string) => {
          const nextLevel = Math.min(6, hashes.length + 2);
          return "#".repeat(nextLevel) + " ";
        });
      }
      return line;
    })
    .join("\n");
}
