import { cmdClean } from "./status.js";
import { cmdScan } from "./scan.js";

export function cmdRebuild(repoRoot: string): void {
  cmdClean(repoRoot);
  cmdScan(repoRoot);
}
