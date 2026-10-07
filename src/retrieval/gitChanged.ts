import { execFileSync } from "node:child_process";

export function changedFilesVsHead(repoRoot: string): string[] {
  let out: string;
  try {
    out = execFileSync("git", ["status", "--porcelain"], {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: 8000,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const line of out.split("\n")) {
    if (line.length < 4) continue;
    let p = line.slice(3).trim();
    const arrow = p.indexOf(" -> ");
    if (arrow >= 0) p = p.slice(arrow + 4);
    if (p.startsWith('"') && p.endsWith('"')) {
      // Porcelain meng-quote path dengan escape C: \\, \", dan oktal \NNN
      // (byte UTF-8 dari nama file non-ASCII). Decode ke string normal.
      const inner = p.slice(1, -1);
      const bytes: number[] = [];
      for (let i = 0; i < inner.length; i++) {
        if (inner[i] === "\\") {
          const next = inner[i + 1];
          if (next >= "0" && next <= "7") {
            bytes.push(parseInt(inner.slice(i + 1, i + 4), 8));
            i += 3;
          } else if (next === "n") { bytes.push(10); i++; }
          else if (next === "t") { bytes.push(9); i++; }
          else { bytes.push(next.charCodeAt(0)); i++; }
        } else {
          bytes.push(inner.charCodeAt(i));
        }
      }
      p = Buffer.from(bytes).toString("utf8");
    }
    if (p) files.push(p);
  }
  return files;
}
