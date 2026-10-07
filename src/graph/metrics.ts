import type { DatabaseSync } from "node:sqlite";

// Graphify Engine — Fitur 3: PageRank & Betweenness Centrality.
// PR(u) = (1-d)/N + d * Σ PR(v)·w(v→u)/outW(v), d = 0.85.
// Betweenness memakai algoritma Brandes (graf berarah, tak-bobot).
// Hasil di-cache di tabel `node_metrics`; dihitung ulang bila kosong/usang.

export const PAGERANK_DAMPING = 0.85;
const MAX_ITERS = 40;
const TOLERANCE = 1e-6;
// Batas agar Brandes O(N·M) tetap murah di repo besar: sampling source.
const BETWEENNESS_SOURCE_CAP = 400;

export interface NodeMetric {
  nodeId: number;
  pagerank: number;
  betweenness: number;
  inDegree: number;
  outDegree: number;
}

interface Edge {
  s: number;
  t: number;
  w: number;
}

function readGraph(db: DatabaseSync): { ids: number[]; edges: Edge[] } {
  let ids: number[] = [];
  try {
    ids = (
      db.prepare(`SELECT id FROM symbols ORDER BY id`).all() as { id: number }[]
    ).map((r) => r.id);
  } catch {
    return { ids: [], edges: [] };
  }
  let edges: Edge[] = [];
  try {
    edges = (
      db
        .prepare(
          `SELECT source_id AS s, target_id AS t,
                  MAX(weight, 0.01) AS w FROM relationships`
        )
        .all() as unknown as Edge[]
    ).filter((e) => e.s !== undefined && e.t !== undefined);
  } catch {
    edges = [];
  }
  return { ids, edges };
}

export function computePageRank(
  db: DatabaseSync,
  damping = PAGERANK_DAMPING
): Map<number, number> {
  const { ids, edges } = readGraph(db);
  const pr = new Map<number, number>();
  const n = ids.length;
  if (n === 0) return pr;
  for (const id of ids) pr.set(id, 1 / n);

  const outW = new Map<number, number>();
  const incoming = new Map<number, { v: number; w: number }[]>();
  for (const e of edges) {
    outW.set(e.s, (outW.get(e.s) ?? 0) + e.w);
    if (!incoming.has(e.t)) incoming.set(e.t, []);
    incoming.get(e.t)!.push({ v: e.s, w: e.w });
  }
  const base = (1 - damping) / n;

  for (let it = 0; it < MAX_ITERS; it++) {
    // Rank dari dangling nodes (out-degree 0) didistribusikan merata.
    let dangling = 0;
    for (const id of ids) {
      if (!outW.has(id) || outW.get(id) === 0) dangling += pr.get(id)!;
    }
    const danglingShare = (damping * dangling) / n;
    let delta = 0;
    const next = new Map<number, number>();
    for (const id of ids) {
      let s = 0;
      for (const inc of incoming.get(id) ?? []) {
        const ow = outW.get(inc.v) ?? 0;
        if (ow > 0) s += ((pr.get(inc.v) ?? 0) * inc.w) / ow;
      }
      const v = base + danglingShare + damping * s;
      next.set(id, v);
      delta = Math.max(delta, Math.abs(v - (pr.get(id) ?? 0)));
    }
    for (const [k, v] of next) pr.set(k, v);
    if (delta < TOLERANCE) break;
  }
  return pr;
}

// Brandes betweenness (directed, unweighted). Dinormalisasi ke [0,1]
// terhadap (N-1)(N-2) bila sampling penuh; bila sampling, tetap proporsional.
export function computeBetweenness(db: DatabaseSync): Map<number, number> {
  const { ids, edges } = readGraph(db);
  const btw = new Map<number, number>();
  for (const id of ids) btw.set(id, 0);
  const n = ids.length;
  if (n === 0) return btw;

  const adj = new Map<number, number[]>();
  for (const e of edges) {
    if (!adj.has(e.s)) adj.set(e.s, []);
    adj.get(e.s)!.push(e.t);
  }
  const sources =
    n > BETWEENNESS_SOURCE_CAP
      ? ids.filter((_, i) => i % Math.ceil(n / BETWEENNESS_SOURCE_CAP) === 0)
      : ids;
  const scale = n / sources.length;

  for (const s of sources) {
    const stack: number[] = [];
    const pred = new Map<number, number[]>();
    const sigma = new Map<number, number>();
    const dist = new Map<number, number>();
    for (const id of ids) {
      pred.set(id, []);
      sigma.set(id, 0);
      dist.set(id, -1);
    }
    sigma.set(s, 1);
    dist.set(s, 0);
    const queue: number[] = [s];
    while (queue.length > 0) {
      const v = queue.shift()!;
      stack.push(v);
      for (const w of adj.get(v) ?? []) {
        if ((dist.get(w) ?? -1) < 0) {
          dist.set(w, (dist.get(v) ?? 0) + 1);
          queue.push(w);
        }
        if (dist.get(w) === (dist.get(v) ?? 0) + 1) {
          sigma.set(w, (sigma.get(w) ?? 0) + (sigma.get(v) ?? 0));
          pred.get(w)!.push(v);
        }
      }
    }
    const delta = new Map<number, number>();
    for (const id of ids) delta.set(id, 0);
    while (stack.length > 0) {
      const w = stack.pop()!;
      for (const v of pred.get(w) ?? []) {
        const c = ((sigma.get(v) ?? 0) / Math.max(1, sigma.get(w) ?? 1)) * (1 + (delta.get(w) ?? 0));
        delta.set(v, (delta.get(v) ?? 0) + c);
      }
      if (w !== s) btw.set(w, (btw.get(w) ?? 0) + (delta.get(w) ?? 0) * scale);
    }
  }
  // Normalisasi: (N-1)(N-2) untuk graf berarah.
  const norm = (n - 1) * (n - 2);
  if (norm > 0) {
    for (const [k, v] of btw) btw.set(k, v / norm);
  }
  return btw;
}

function degrees(db: DatabaseSync): Map<number, { inn: number; out: number }> {
  const m = new Map<number, { inn: number; out: number }>();
  try {
    for (const r of db
      .prepare(`SELECT target_id AS t, COUNT(*) AS n FROM relationships GROUP BY target_id`)
      .all() as { t: number; n: number }[]) {
      m.set(r.t, { inn: r.n, out: m.get(r.t)?.out ?? 0 });
    }
    for (const r of db
      .prepare(`SELECT source_id AS s, COUNT(*) AS n FROM relationships GROUP BY source_id`)
      .all() as { s: number; n: number }[]) {
      m.set(r.s, { inn: m.get(r.s)?.inn ?? 0, out: r.n });
    }
  } catch {
    // ignore
  }
  return m;
}

/** Hitung ulang PageRank + betweenness + degree, simpan ke `node_metrics`. */
export function refreshMetrics(db: DatabaseSync): number {
  const { ids } = readGraph(db);
  if (ids.length === 0) return 0;
  const pr = computePageRank(db);
  const btw = computeBetweenness(db);
  const deg = degrees(db);
  try {
    db.prepare(`DELETE FROM node_metrics WHERE node_id NOT IN (SELECT id FROM symbols)`).run();
  } catch {
    // ignore
  }
  const up = db.prepare(
    `INSERT INTO node_metrics(node_id, pagerank, betweenness, in_degree, out_degree, updated_at)
     VALUES (?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(node_id) DO UPDATE SET
       pagerank = excluded.pagerank, betweenness = excluded.betweenness,
       in_degree = excluded.in_degree, out_degree = excluded.out_degree,
       updated_at = excluded.updated_at`
  );
  let n = 0;
  for (const id of ids) {
    up.run(id, pr.get(id) ?? 0, btw.get(id) ?? 0, deg.get(id)?.inn ?? 0, deg.get(id)?.out ?? 0);
    n++;
  }
  return n;
}

/** Pastikan `node_metrics` terisi; hitung bila kosong. Kembalikan jumlah baris. */
export function ensureMetrics(db: DatabaseSync): number {
  try {
    const syms = (db.prepare(`SELECT COUNT(*) AS n FROM symbols`).get() as { n: number }).n;
    if (syms === 0) return 0;
    // Cache basi bila ada simbol tanpa metrik, atau metrik yatim dari
    // simbol yang sudah dihapus/diganti (id baru setelah re-index).
    const missing = (db.prepare(
      `SELECT COUNT(*) AS n FROM symbols s LEFT JOIN node_metrics m ON m.node_id = s.id WHERE m.node_id IS NULL`
    ).get() as { n: number }).n;
    const orphans = (db.prepare(
      `SELECT COUNT(*) AS n FROM node_metrics m LEFT JOIN symbols s ON s.id = m.node_id WHERE s.id IS NULL`
    ).get() as { n: number }).n;
    if (missing === 0 && orphans === 0) {
      return (db.prepare(`SELECT COUNT(*) AS n FROM node_metrics`).get() as { n: number }).n;
    }
    return refreshMetrics(db);
  } catch {
    return 0;
  }
}

export function getMetrics(db: DatabaseSync, nodeId: number): NodeMetric | null {
  try {
    const r = db.prepare(`SELECT * FROM node_metrics WHERE node_id = ?`).get(nodeId) as
      | { node_id: number; pagerank: number; betweenness: number; in_degree: number; out_degree: number }
      | undefined;
    if (!r) return null;
    return { nodeId: r.node_id, pagerank: r.pagerank, betweenness: r.betweenness, inDegree: r.in_degree, outDegree: r.out_degree };
  } catch {
    return null;
  }
}

/** Simbol paling kritis menurut PageRank (untuk context ranking & doctor). */
export function topByPageRank(
  db: DatabaseSync,
  limit = 10
): { id: number; name: string; type: string; file: string; pagerank: number; inDegree: number; outDegree: number }[] {
  ensureMetrics(db);
  try {
    return db.prepare(
      `SELECT s.id, s.name, s.type, f.path AS file, m.pagerank, m.in_degree AS inDegree, m.out_degree AS outDegree
       FROM node_metrics m JOIN symbols s ON s.id = m.node_id
       JOIN files f ON f.id = s.file_id
       ORDER BY m.pagerank DESC LIMIT ${Math.max(1, Math.min(50, limit))}`
    ).all() as { id: number; name: string; type: string; file: string; pagerank: number; inDegree: number; outDegree: number }[];
  } catch {
    return [];
  }
}
