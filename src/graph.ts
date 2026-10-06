import type { DatabaseSync } from "node:sqlite";

export interface GraphNode {
  id: number;
  name: string;
  type: string;
  file: string;
}

export interface GraphEdge {
  rel: string;
  weight: number;
  confidence: number;
  other: GraphNode;
  direction: "out" | "in";
}

function asNode(r: Record<string, unknown>): GraphNode {
  return {
    id: r["id"] as number,
    name: r["name"] as string,
    type: r["type"] as string,
    file: (r["file"] as string) ?? "",
  };
}

// Resolve symbol(s) by exact name, then file path fallback.
export function findSymbols(db: DatabaseSync, key: string): GraphNode[] {
  const byName = db
    .prepare(
      `SELECT s.id, s.name, s.type, f.path AS file FROM symbols s
       JOIN files f ON f.id = s.file_id WHERE s.name = ? LIMIT 20`
    )
    .all(key) as Record<string, unknown>[];
  if (byName.length > 0) return byName.map(asNode);
  const like = db
    .prepare(
      `SELECT s.id, s.name, s.type, f.path AS file FROM symbols s
       JOIN files f ON f.id = s.file_id
       WHERE s.name LIKE ? OR f.path LIKE ? LIMIT 20`
    )
    .all(`%${key}%`, `%${key}%`) as Record<string, unknown>[];
  return like.map(asNode);
}

export function neighbors(
  db: DatabaseSync,
  id: number,
  limit = 50
): GraphEdge[] {  const out = db
    .prepare(
      `SELECT r.relationship_type AS rel, r.weight, r.confidence,
              t.id, t.name, t.type, f.path AS file
       FROM relationships r JOIN symbols t ON t.id = r.target_id
       JOIN files f ON f.id = t.file_id
       WHERE r.source_id = ? LIMIT ${limit}`
    )
    .all(id) as Record<string, unknown>[];
  const inn = db
    .prepare(
      `SELECT r.relationship_type AS rel, r.weight, r.confidence,
              s.id, s.name, s.type, f.path AS file
       FROM relationships r JOIN symbols s ON s.id = r.source_id
       JOIN files f ON f.id = s.file_id
       WHERE r.target_id = ? LIMIT ${limit}`
    )
    .all(id) as Record<string, unknown>[];
  return [
    ...out.map((r) => ({
      rel: r["rel"] as string,
      weight: r["weight"] as number,
      confidence: r["confidence"] as number,
      other: asNode(r),
      direction: "out" as const,
    })),
    ...inn.map((r) => ({
      rel: r["rel"] as string,
      weight: r["weight"] as number,
      confidence: r["confidence"] as number,
      other: asNode(r),
      direction: "in" as const,
    })),
  ];
}

export interface PathHop {
  from: GraphNode;
  rel: string;
  to: GraphNode;
}

// Graphify Engine — Fitur 4: multi-hop shortest call path (BFS berarah).
// Mengikuti edge source → target apa pun tipenya (CALLS, IMPORTS, QUERIES…).
export function findShortestPath(
  db: DatabaseSync,
  fromId: number,
  toId: number,
  maxDepth = 8,
  fanout = 200
): PathHop[] | null {
  if (fromId === toId) return [];
  const prev = new Map<number, { p: number; rel: string }>();
  const seen = new Set<number>([fromId]);
  let frontier = [fromId];
  let found = false;
  for (let d = 0; d < maxDepth && frontier.length > 0; d++) {
    const next: number[] = [];
    for (const cur of frontier) {
      let rows: { t: number; rel: string }[] = [];
      try {
        rows = db
          .prepare(
            `SELECT target_id AS t, relationship_type AS rel FROM relationships
             WHERE source_id = ? LIMIT ${Math.max(1, Math.min(1000, fanout))}`
          )
          .all(cur) as { t: number; rel: string }[];
      } catch {
        rows = [];
      }
      for (const r of rows) {
        if (seen.has(r.t)) continue;
        seen.add(r.t);
        prev.set(r.t, { p: cur, rel: r.rel });
        if (r.t === toId) {
          found = true;
          break;
        }
        next.push(r.t);
      }
      if (found) break;
    }
    if (found) break;
    frontier = next;
  }
  if (!found) return null;
  // Rekonstruksi rantai id, lalu hydrasi node.
  const chain: number[] = [toId];
  let cur = toId;
  while (cur !== fromId) {
    const step = prev.get(cur);
    if (!step) return null;
    chain.push(step.p);
    cur = step.p;
  }
  chain.reverse();
  const info = new Map<number, GraphNode>();
  try {
    const rows = db
      .prepare(
        `SELECT s.id, s.name, s.type, f.path AS file FROM symbols s
         JOIN files f ON f.id = s.file_id`
      )
      .all() as Record<string, unknown>[];
    for (const r of rows) {
      const n = asNode(r);
      if (chain.includes(n.id)) info.set(n.id, n);
    }
  } catch {
    return null;
  }
  const hops: PathHop[] = [];
  for (let i = 0; i < chain.length - 1; i++) {
    const a = info.get(chain[i]);
    const b = info.get(chain[i + 1]);
    if (!a || !b) return null;
    hops.push({ from: a, rel: prev.get(chain[i + 1])!.rel, to: b });
  }
  return hops;
}
