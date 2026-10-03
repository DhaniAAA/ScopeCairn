import { scanRepository, type ScanStats } from "./scanner.js";

export interface RefreshResult {
  stats: ScanStats;
  /** True bila perubahan sangat besar (mis. ganti branch) — sarankan scan penuh. */
  bulk: boolean;
}

const BULK_THRESHOLD = 50;

// Auto-refresh inkremental (PRD FR-12, AI-6): bandingkan hash, parse ulang
// hanya file berubah. Ringan untuk task sederhana.
export function refreshIndex(repoRoot: string): RefreshResult {
  const stats = scanRepository(repoRoot);
  const bulk = stats.inserted + stats.updated > BULK_THRESHOLD;
  return { stats, bulk };
}
