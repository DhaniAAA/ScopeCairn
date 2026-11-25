import fs from "node:fs";
import { loadIgnoreRules, isIgnored } from "../ignore.js";
import { refreshIndex } from "../refresh.js";

export interface WatchOptions {
  debounce?: number;
}

const WATCH_IGNORED_SEGMENTS = new Set([
  ".git",
  ".scopecairn",
  "node_modules",
  "dist",
  "build",
  "target",
  "coverage",
  ".next",
]);

/** Cek apakah path relatif mengandung segmen internal/build yang selalu diabaikan watcher. */
export function isWatchExcludedPath(relPosix: string): boolean {
  const clean = relPosix.replace(/\\/g, "/").replace(/^\.\//, "");
  if (!clean) return false;
  return clean.split("/").some((seg) => WATCH_IGNORED_SEGMENTS.has(seg));
}

export async function cmdWatch(
  repoRoot: string,
  opts: WatchOptions = {}
): Promise<void> {
  const debounceMs = opts.debounce ?? 300;
  console.log(`[Watch] ScopeCairn watching for changes in: ${repoRoot}`);
  console.log(`[Watch] Debounce: ${debounceMs}ms. Press Ctrl+C to stop.\n`);

  let ignoreRules = loadIgnoreRules(repoRoot);
  let timer: NodeJS.Timeout | null = null;
  const pendingFiles = new Set<string>();
  let isRefreshing = false;

  const triggerRefresh = async () => {
    if (isRefreshing) return;
    isRefreshing = true;
    const changedList = Array.from(pendingFiles);
    pendingFiles.clear();

    const sample = changedList.slice(0, 3).join(", ");
    const more = changedList.length > 3 ? ` (+${changedList.length - 3} more)` : "";
    console.log(`[Watch] Detected change in ${changedList.length} file(s): ${sample}${more}`);

    try {
      const start = Date.now();
      const { stats } = await refreshIndex(repoRoot, { changedPaths: changedList });
      const elapsed = Date.now() - start;
      console.log(
        `[Watch] Re-indexed in ${elapsed}ms (+${stats.inserted} new, ~${stats.updated} updated, -${stats.removed} removed).\n`
      );
    } catch (err) {
      console.error(`[Watch] Error re-indexing:`, err);
    } finally {
      isRefreshing = false;
      // Bila ada event yang masuk saat proses refresh
      if (pendingFiles.size > 0) {
        timer = setTimeout(triggerRefresh, debounceMs);
      }
    }
  };

  const watcher = fs.watch(repoRoot, { recursive: true }, (_eventType, filename) => {
    if (!filename) return;

    const relPosix = filename.replace(/\\/g, "/");

    // Abaikan direktori internal & artefak build di root maupun subpaket monorepo
    if (isWatchExcludedPath(relPosix)) {
      return;
    }

    // .gitignore berubah → muat ulang aturan agar penghormatan ignore selalu segar.
    if (relPosix === ".gitignore" || relPosix === ".scopecairnignore") {
      ignoreRules = loadIgnoreRules(repoRoot);
    }

    if (isIgnored(relPosix, ignoreRules)) {
      return;
    }

    pendingFiles.add(relPosix);

    if (timer) clearTimeout(timer);
    timer = setTimeout(triggerRefresh, debounceMs);
  });

  process.on("SIGINT", () => {
    console.log("\n[Watch] Stopping ScopeCairn file watcher...");
    watcher.close();
    process.exit(0);
  });
}
