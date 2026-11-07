import { scanRepository, type ScanStats, type ScanRepositoryOptions } from "./scanner.js";
export interface RefreshOptions {
  /** Teruskan ke scanRepository: hanya proses file git-dirty. */
  changedOnly?: boolean;
}

export interface RefreshResult {
  stats: ScanStats;
  /** True bila perubahan sangat besar (mis. ganti branch) — sarankan scan penuh. */
  bulk: boolean;
}

const BULK_THRESHOLD = 50;

// Auto-refresh inkremental (PRD FR-12, AI-6): bandingkan hash, parse ulang
// hanya file berubah. Ringan untuk task sederhana.
export async function refreshIndex(
  repoRoot: string,
  opts?: RefreshOptions | ScanRepositoryOptions
): Promise<RefreshResult> {
  const stats = await scanRepository(repoRoot, { changedOnly: opts?.changedOnly === true });
  const bulk = stats.inserted + stats.updated > BULK_THRESHOLD;
  return { stats, bulk };
}
