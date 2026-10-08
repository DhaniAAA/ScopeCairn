import { scanRepository, type ScanStats } from "./scanner.js";

export interface RefreshResult {
  stats: ScanStats;
  /** True bila perubahan sangat besar (mis. ganti branch) — sarankan scan penuh. */
  bulk: boolean;
}

const BULK_THRESHOLD = 50;

// Auto-refresh inkremental (PRD FR-12, AI-6): bandingkan hash, parse ulang
// hanya file berubah. Ringan untuk task sederhana.
export async function refreshIndex(repoRoot: string): Promise<RefreshResult> {
  const stats = await scanRepository(repoRoot);
  const bulk = stats.inserted + stats.updated > BULK_THRESHOLD;
  return { stats, bulk };
}
