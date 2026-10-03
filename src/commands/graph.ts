import { openDb } from "../db.js";
import { logInvocation } from "../invocations.js";
import { findSymbols, neighbors } from "../graph.js";

export function cmdGraph(repoRoot: string, key: string): void {
  const db = openDb(repoRoot);
  try {
    logInvocation(db, "graph");
    const hits = findSymbols(db, key);
    if (hits.length === 0) {
      console.log(`No symbol or file matching "${key}".`);
      return;
    }
    // Prefer exact name match; else first hit.
    const node =
      hits.find((h) => h.name === key) ?? hits[0];
    if (hits.length > 1) {
      console.log(`Matches: ${hits.map((h) => `${h.name} (${h.type}, ${h.file})`).join(" | ")}`);
      console.log(`Showing: ${node.name} (${node.type}, ${node.file})`);
      console.log("");
    } else {
      console.log(`${node.name} (${node.type}) — ${node.file}`);
      console.log("");
    }
    const edges = neighbors(db, node.id);
    if (edges.length === 0) {
      console.log("(no relations)");
      return;
    }
    const out = edges.filter((e) => e.direction === "out");
    const inn = edges.filter((e) => e.direction === "in");
    if (out.length > 0) {
      console.log("Outgoing:");
      for (const e of out.slice(0, 30)) {
        console.log(
          `  ${e.rel} → ${e.other.name} (${e.other.type}, ${e.other.file}) [w=${e.weight} c=${e.confidence}]`
        );
      }
    }
    if (inn.length > 0) {
      console.log("Incoming:");
      for (const e of inn.slice(0, 30)) {
        console.log(
          `  ${e.rel} ← ${e.other.name} (${e.other.type}, ${e.other.file}) [w=${e.weight} c=${e.confidence}]`
        );
      }
    }
  } finally {
    db.close();
  }
}
