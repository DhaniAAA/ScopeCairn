import fs from "node:fs";
import { dataDir } from "../db.js";
import { cmdScan } from "./scan.js";

export function cmdRebuild(repoRoot: string): void {
  const dir = dataDir(repoRoot);
  // Close WAL sidecars by removing whole dir.
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`Cleaned ${dir}`);
  cmdScan(repoRoot);
}
