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
): GraphEdge[] {
  const out = db
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
