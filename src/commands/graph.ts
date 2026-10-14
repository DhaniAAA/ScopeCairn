import { openDb } from "../db.js";
import { logInvocation } from "../invocations.js";
import { findSymbols, neighbors } from "../graph.js";
import { getMetrics, ensureMetrics } from "../graph/metrics.js";
import { getCluster, ensureClusters } from "../graph/clusters.js";
import { nodeInCycle } from "../graph/cycles.js";
import { cmdPath } from "./path.js";
import { cmdExport } from "./export.js";

export interface GraphOptions {
  json?: boolean;
  to?: string;
  export?: string;
  out?: string;
}

export function cmdGraph(repoRoot: string, key?: string, opts: GraphOptions = {}): void {
  if (opts.export) {
    cmdExport(repoRoot, opts.export, opts.out);
    return;
  }
  if (!key) {
    console.log("Usage: scopecairn graph <symbol> [--to <target>] [--export <fmt>]");
    return;
  }
  if (opts.to) {
    cmdPath(repoRoot, key, opts.to, { json: opts.json });
    return;
  }

  const db = openDb(repoRoot);
  try {
    logInvocation(db, "graph");
    const hits = findSymbols(db, key);
    if (hits.length === 0) {
      if (opts.json) console.log(JSON.stringify({ key, error: `No symbol or file matching "${key}".` }, null, 2));
      else console.log(`No symbol or file matching "${key}".`);
      return;
    }
    // Prefer exact name match; else first hit.
    const node =
      hits.find((h) => h.name === key) ?? hits[0];
    const edges = neighbors(db, node.id);
    let metrics: { pagerank?: number; betweenness?: number; inDegree?: number; outDegree?: number; community?: string; inCycle?: boolean } | undefined;
    // Graphify Engine: skor centrality + komunitas + status siklus node.
    try {
      ensureMetrics(db);
      ensureClusters(db);
      const m = getMetrics(db, node.id);
      const c = getCluster(db, node.id);
      if (m || c) {
        metrics = {};
        if (m) { metrics.pagerank = m.pagerank; metrics.betweenness = m.betweenness; metrics.inDegree = m.inDegree; metrics.outDegree = m.outDegree; }
        if (c) metrics.community = c.clusterName;
        try { if (nodeInCycle(db, node.id)) metrics.inCycle = true; } catch { /* ignore */ }
      }
    } catch {
      // metrik opsional — jangan gagalkan perintah graph
    }
    if (opts.json) {
      console.log(JSON.stringify({
        key,
        node: { name: node.name, type: node.type, file: node.file },
        matches: hits.slice(0, 5).map((h) => ({ name: h.name, type: h.type, file: h.file })),
        metrics,
        edges: edges.slice(0, 60).map((e) => ({ rel: e.rel, direction: e.direction, name: e.other.name, type: e.other.type, file: e.other.file, weight: e.weight, confidence: e.confidence })),
      }, null, 2));
      return;
    }
    if (hits.length > 1) {
      console.log(`Matches: ${hits.map((h) => `${h.name} (${h.type}, ${h.file})`).join(" | ")}`);
      console.log(`Showing: ${node.name} (${node.type}, ${node.file})`);
      console.log("");
    } else {
      console.log(`${node.name} (${node.type}) — ${node.file}`);
      console.log("");
    }
    if (metrics) {
      const parts: string[] = [];
      const m = getMetrics(db, node.id);
      const c = getCluster(db, node.id);
      if (m) parts.push(`pr=${m.pagerank.toFixed(4)} btw=${m.betweenness.toFixed(4)} in=${m.inDegree} out=${m.outDegree}`);
      if (c) parts.push(`community=${c.clusterName}`);
      if (metrics.inCycle) parts.push(`IN CYCLE`);
      if (parts.length > 0) console.log(`Metrics: ${parts.join(" · ")}`);
    }
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
