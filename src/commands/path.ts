import { openDb } from "../db.js";
import { logInvocation } from "../invocations.js";
import { findShortestPath, findSymbols } from "../graph.js";

// Graphify Engine — Fitur 4: `scopecairn path <A> <B>`.
// Melacak alur panggilan/ketergantungan terpendek dari simbol awal ke target.
export function cmdPath(repoRoot: string, from: string, to: string): void {
  const db = openDb(repoRoot);
  try {
    logInvocation(db, "path");
    const aHits = findSymbols(db, from);
    const bHits = findSymbols(db, to);
    if (aHits.length === 0) {
      console.log(`No symbol or file matching "${from}".`);
      return;
    }
    if (bHits.length === 0) {
      console.log(`No symbol or file matching "${to}".`);
      return;
    }
    const a = aHits.find((h) => h.name === from) ?? aHits[0];
    const b = bHits.find((h) => h.name === to) ?? bHits[0];
    const hops = findShortestPath(db, a.id, b.id);
    if (!hops) {
      console.log(`No path from "${a.name}" to "${b.name}" (max 8 hops).`);
      if (aHits.length > 1 || bHits.length > 1) {
        console.log(
          `From candidates: ${aHits.slice(0, 5).map((h) => `${h.name} (${h.file})`).join(" | ")}`
        );
        console.log(
          `To candidates: ${bHits.slice(0, 5).map((h) => `${h.name} (${h.file})`).join(" | ")}`
        );
      }
      return;
    }
    if (hops.length === 0) {
      console.log(`"${a.name}" and "${b.name}" resolve to the same symbol.`);
      return;
    }
    console.log(`Path found (${hops.length} hop${hops.length === 1 ? "" : "s"}):`);
    hops.forEach((h, i) => {
      console.log(`[${i + 1}] ${h.from.name} (${h.from.type}, ${h.from.file})`);
      console.log(`     └─(${h.rel})─> ${h.to.name} (${h.to.type}, ${h.to.file})`);
    });
  } finally {
    db.close();
  }
}
