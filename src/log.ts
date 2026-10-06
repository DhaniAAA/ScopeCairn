import fs from "node:fs";
import path from "node:path";

export function lastRunLogPath(repoRoot: string = process.cwd()): string {
  return path.join(repoRoot, ".scopecairn", "last-run.log");
}

function append(repoRoot: string | undefined, scope: string, text: string): void {
  const root = repoRoot ?? process.cwd();
  try {
    fs.mkdirSync(path.dirname(lastRunLogPath(root)), { recursive: true });
    fs.appendFileSync(lastRunLogPath(root), text + "\n", "utf8");
  } catch {
    // logging must never break the caller
  }
}

export function logError(scope: string, err: unknown, repoRoot?: string): void {
  const message = err instanceof Error ? err.message : String(err);
  append(repoRoot, scope, `${new Date().toISOString()} [${scope}] ${message}`);
}

export function logNote(scope: string, msg: string, repoRoot?: string): void {
  append(repoRoot, scope, `${new Date().toISOString()} [${scope}] ${msg}`);
}
