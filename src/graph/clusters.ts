import type { DatabaseSync } from "node:sqlite";

// Graphify Engine — Fitur 1: Dynamic Community Detection (Louvain, 2 fase).
// Mengelompokkan simbol berdasar kepadatan interkoneksi nyata (skor
// modularitas Q), bukan struktur folder fisik.
// Fase 1: optimasi modularitas lokal (pindah node ke komunitas tetangga).
// Fase 2: agregasi komunitas jadi super-node, ulangi hingga Q konvergen.

export interface ClusterInfo {
  nodeId: number;
  clusterId: number;
  clusterName: string;
  modularity: number;
}

interface WEdge {
  a: number;
  b: number;
  w: number;
}

function readUndirected(db: DatabaseSync): { ids: number[]; edges: WEdge[] } {
  let ids: number[] = [];
  try {
    ids = (db.prepare(`SELECT id FROM symbols ORDER BY id`).all() as { id: number }[]).map((r) => r.id);
  } catch {
    return { ids: [], edges: [] };
  }
  const agg = new Map<string, WEdge>();
  try {
    const rows = db.prepare(
      `SELECT source_id AS s, target_id AS t, SUM(MAX(weight, 0.01)) AS w
       FROM relationships GROUP BY source_id, target_id`
    ).all() as { s: number; t: number; w: number }[];
    for (const r of rows) {
      if (r.s === r.t) continue; // self-loop tak mempengaruhi komunitas
      const key = r.s < r.t ? `${r.s}:${r.t}` : `${r.t}:${r.s}`;
      const e = agg.get(key);
      if (e) e.w += r.w;
      else agg.set(key, { a: Math.min(r.s, r.t), b: Math.max(r.s, r.t), w: r.w });
    }
  } catch {
    // ignore
  }
  return { ids, edges: [...agg.values()] };
}

function modularity(
  comm: Map<number, number>,
  edges: WEdge[],
  degree: Map<number, number>,
  m2: number
): number {
  if (m2 === 0) return 0;
  const inSum = new Map<number, number>();
  const totSum = new Map<number, number>();
  for (const [node, c] of comm) {
    totSum.set(c, (totSum.get(c) ?? 0) + (degree.get(node) ?? 0));
  }
  for (const e of edges) {
    if (comm.get(e.a) === comm.get(e.b)) {
      inSum.set(comm.get(e.a)!, (inSum.get(comm.get(e.a)!) ?? 0) + 2 * e.w);
    }
  }
  let q = 0;
  for (const [c, tot] of totSum) {
    q += (inSum.get(c) ?? 0) / m2 - (tot / m2) * (tot / m2);
  }
  return q;
}

/** Satu pass optimasi lokal. Kembalikan true bila ada node berpindah. */
function localMove(
  nodes: number[],
  adj: Map<number, { to: number; w: number }[]>,
  comm: Map<number, number>,
  commTot: Map<number, number>,
  degree: Map<number, number>,
  m2: number
): boolean {
  let moved = false;
  for (const node of nodes) {
    const cur = comm.get(node)!;
    const ki = degree.get(node) ?? 0;
    // Bobot ke tiap komunitas tetangga.
    const toComm = new Map<number, number>();
    for (const { to, w } of adj.get(node) ?? []) {
      const c = comm.get(to)!;
      toComm.set(c, (toComm.get(c) ?? 0) + w);
    }
    // Keluarkan node dari komunitasnya.
    commTot.set(cur, (commTot.get(cur) ?? 0) - ki);
    let best = cur;
    let bestGain = 0;
    for (const [c, kin] of toComm) {
      if (c === cur) continue;
      const gain = kin - ((commTot.get(c) ?? 0) * ki) / Math.max(m2, 1e-9);
      if (gain > bestGain) {
        bestGain = gain;
        best = c;
      }
    }
    // Gain bertahan di komunitas sendiri = bobot internal - penalti.
    const selfGain = (toComm.get(cur) ?? 0) - ((commTot.get(cur) ?? 0) * ki) / Math.max(m2, 1e-9);
    if (best !== cur && bestGain > selfGain) {
      comm.set(node, best);
      commTot.set(best, (commTot.get(best) ?? 0) + ki);
      moved = true;
    } else {
      commTot.set(cur, (commTot.get(cur) ?? 0) + ki);
    }
  }
  return moved;
}

/**
 * Jalankan Louvain penuh. Kembalikan peta node → cluster + modularitas akhir.
 * Deterministik: urutan node diurutkan by id, tanpa random.
 */
export function louvain(db: DatabaseSync): { assignment: Map<number, number>; modularity: number } {
  const { ids, edges } = readUndirected(db);
  const assignment = new Map<number, number>();
  if (ids.length === 0) return { assignment, modularity: 0 };

  // Level hierarki: tiap level memetakan anggota → super-node.
  let levelNodes = [...ids].sort((a, b) => a - b);
  let levelEdges = edges;
  // Jejak: untuk tiap super-node, daftar node asli di dalamnya.
  let members = new Map<number, number[]>();
  for (const id of ids) members.set(id, [id]);

  for (let level = 0; level < 8; level++) {
    const adj = new Map<number, { to: number; w: number }[]>();
    const degree = new Map<number, number>();
    for (const n of levelNodes) {
      adj.set(n, []);
      degree.set(n, 0);
    }
    let m2 = 0;
    for (const e of levelEdges) {
      adj.get(e.a)?.push({ to: e.b, w: e.w });
      adj.get(e.b)?.push({ to: e.a, w: e.w });
      degree.set(e.a, (degree.get(e.a) ?? 0) + e.w);
      degree.set(e.b, (degree.get(e.b) ?? 0) + e.w);
      m2 += 2 * e.w;
    }
    const comm = new Map<number, number>();
    const commTot = new Map<number, number>();
    for (const n of levelNodes) {
      comm.set(n, n);
      commTot.set(n, degree.get(n) ?? 0);
    }
    for (let pass = 0; pass < 10; pass++) {
      if (!localMove(levelNodes, adj, comm, commTot, degree, m2)) break;
    }
    // Kompakkan id komunitas.
    const remap = new Map<number, number>();
    let next = 0;
    for (const n of levelNodes) {
      const c = comm.get(n)!;
      if (!remap.has(c)) remap.set(c, next++);
      comm.set(n, remap.get(c)!);
    }
    // Petakan kembali ke node asli.
    const newMembers = new Map<number, number[]>();
    for (const n of levelNodes) {
      const c = comm.get(n)!;
      if (!newMembers.has(c)) newMembers.set(c, []);
      newMembers.get(c)!.push(...(members.get(n) ?? [n]));
    }
    members = newMembers;
    if (remap.size === levelNodes.length || remap.size <= 1) break; // konvergen
    // Agregasi: bangun graf super-node.
    const agg = new Map<string, number>();
    for (const e of levelEdges) {
      const ca = comm.get(e.a)!;
      const cb = comm.get(e.b)!;
      if (ca === cb) continue;
      const key = ca < cb ? `${ca}:${cb}` : `${cb}:${ca}`;
      agg.set(key, (agg.get(key) ?? 0) + e.w);
    }
    levelNodes = [...members.keys()].sort((a, b) => a - b);
    levelEdges = [...agg.entries()].map(([k, w]) => {
      const [a, b] = k.split(":").map(Number);
      return { a, b, w };
    });
    if (levelEdges.length === 0) break;
  }

  for (const [superId, mems] of members) {
    for (const m of mems) assignment.set(m, superId);
  }
  // Normalisasi id cluster 0..K-1.
  const remap = new Map<number, number>();
  let next = 0;
  for (const id of ids) {
    const c = assignment.get(id) ?? 0;
    if (!remap.has(c)) remap.set(c, next++);
    assignment.set(id, remap.get(c)!);
  }
  // Modularity atas graf asli.
  const degree = new Map<number, number>();
  let m2 = 0;
  for (const e of edges) {
    degree.set(e.a, (degree.get(e.a) ?? 0) + e.w);
    degree.set(e.b, (degree.get(e.b) ?? 0) + e.w);
    m2 += 2 * e.w;
  }
  const q = modularity(assignment, edges, degree, m2);
  return { assignment, modularity: q };
}

/** Hitung Louvain lalu simpan ke tabel `clusters`. Kembalikan (K, Q). */
export function refreshClusters(db: DatabaseSync): { count: number; modularity: number } {
  const { assignment, modularity: q } = louvain(db);
  if (assignment.size === 0) return { count: 0, modularity: 0 };
  try {
    db.prepare(`DELETE FROM clusters WHERE node_id NOT IN (SELECT id FROM symbols)`).run();
  } catch {
    // ignore
  }
  // Nama cluster dari direktori teratas terbanyak anggotanya.
  const names = new Map<number, string>();
  try {
    const byCluster = new Map<number, Map<string, number>>();
    for (const [nodeId, cid] of assignment) {
      const r = db
        .prepare(`SELECT f.path AS p FROM symbols s JOIN files f ON f.id = s.file_id WHERE s.id = ?`)
        .get(nodeId) as { p: string } | undefined;
      const top = (r?.p ?? "").split("/")[0] || ".";
      if (!byCluster.has(cid)) byCluster.set(cid, new Map());
      const m = byCluster.get(cid)!;
      m.set(top, (m.get(top) ?? 0) + 1);
    }
    for (const [cid, m] of byCluster) {
      let best = ".";
      let bestN = -1;
      for (const [k, v] of m) {
        if (v > bestN) {
          bestN = v;
          best = k;
        }
      }
      names.set(cid, `cluster-${cid} (${best}/)`);
    }
  } catch {
    // ignore — pakai nama generik
  }
  const up = db.prepare(
    `INSERT INTO clusters(node_id, cluster_id, cluster_name, modularity)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(node_id) DO UPDATE SET
       cluster_id = excluded.cluster_id, cluster_name = excluded.cluster_name,
       modularity = excluded.modularity`
  );
  for (const [nodeId, cid] of assignment) {
    up.run(nodeId, cid, names.get(cid) ?? `cluster-${cid}`, q);
  }
  return { count: new Set(assignment.values()).size, modularity: q };
}

export function ensureClusters(db: DatabaseSync): number {
  try {
    const syms = (db.prepare(`SELECT COUNT(*) AS n FROM symbols`).get() as { n: number }).n;
    if (syms === 0) return 0;
    // Cache basi bila ada simbol tanpa cluster, atau cluster yatim dari
    // simbol yang sudah dihapus/diganti (id baru setelah re-index).
    const missing = (db.prepare(
      `SELECT COUNT(*) AS n FROM symbols s LEFT JOIN clusters c ON c.node_id = s.id WHERE c.node_id IS NULL`
    ).get() as { n: number }).n;
    const orphans = (db.prepare(
      `SELECT COUNT(*) AS n FROM clusters c LEFT JOIN symbols s ON s.id = c.node_id WHERE s.id IS NULL`
    ).get() as { n: number }).n;
    if (missing > 0 || orphans > 0) {
      refreshClusters(db);
    }
    return (db.prepare(`SELECT COUNT(*) AS n FROM clusters`).get() as { n: number }).n;
  } catch {
    return 0;
  }
}

export function getCluster(db: DatabaseSync, nodeId: number): ClusterInfo | null {
  try {
    const r = db.prepare(`SELECT * FROM clusters WHERE node_id = ?`).get(nodeId) as
      | { node_id: number; cluster_id: number; cluster_name: string; modularity: number }
      | undefined;
    if (!r) return null;
    return { nodeId: r.node_id, clusterId: r.cluster_id, clusterName: r.cluster_name ?? "", modularity: r.modularity ?? 0 };
  } catch {
    return null;
  }
}
