import crypto from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

// Graphify Engine — Deteksi Siklus: Tarjan SCC (iteratif) + caching di
// tabel `cycles`. Satu baris per komponen terkoneksi kuat (size > 1 atau
// self-loop). `cycle_hash` = sha1 dari id terurut → idempoten.

export interface Cycle {
  id: number;
  hash: string;
  length: number;
  nodeIds: number[];
}

function readAdj(db: DatabaseSync): { ids: number[]; adj: Map<number, number[]> } {
  let ids: number[] = [];
  try {
    ids = (db.prepare(`SELECT id FROM symbols ORDER BY id`).all() as { id: number }[]).map((r) => r.id);
  } catch {
    return { ids: [], adj: new Map() };
  }
  const adj = new Map<number, number[]>();
  for (const id of ids) adj.set(id, []);
  try {
    const rows = db.prepare(`SELECT source_id AS s, target_id AS t FROM relationships`).all() as {
      s: number;
      t: number;
    }[];
    for (const r of rows) {
      if (adj.has(r.s)) adj.get(r.s)!.push(r.t);
    }
  } catch {
    // ignore
  }
  return { ids, adj };
}

/** Tarjan SCC iteratif. Kembalikan daftar komponen (tiap komponen = daftar id). */
export function stronglyConnected(db: DatabaseSync): number[][] {
  const { ids, adj } = readAdj(db);
  const index = new Map<number, number>();
  const low = new Map<number, number>();
  const onStack = new Set<number>();
  const stack: number[] = [];
  const out: number[][] = [];
  let counter = 0;

  for (const root of ids) {
    if (index.has(root)) continue;
    const work: { v: number; i: number }[] = [{ v: root, i: 0 }];
    while (work.length > 0) {
      const top = work[work.length - 1];
      const v = top.v;
      if (!index.has(v)) {
        index.set(v, counter);
        low.set(v, counter);
        counter++;
        stack.push(v);
        onStack.add(v);
      }
      const nbrs = adj.get(v) ?? [];
      if (top.i < nbrs.length) {
        const w = nbrs[top.i++];
        if (!index.has(w)) {
          work.push({ v: w, i: 0 });
        } else if (onStack.has(w)) {
          low.set(v, Math.min(low.get(v)!, index.get(w)!));
        }
      } else {
        work.pop();
        if (work.length > 0) {
          const parent = work[work.length - 1].v;
          low.set(parent, Math.min(low.get(parent)!, low.get(v)!));
        }
        if (low.get(v) === index.get(v)) {
          const comp: number[] = [];
          let w: number;
          do {
            w = stack.pop()!;
            onStack.delete(w);
            comp.push(w);
          } while (w !== v);
          out.push(comp);
        }
      }
    }
  }
  return out;
}

function hashIds(ids: number[]): string {
  return crypto.createHash("sha1").update([...ids].sort((a, b) => a - b).join(",")).digest("hex");
}

/**
 * Deteksi siklus lalu cache ke tabel `cycles` (upsert by hash).
 * Kembalikan daftar siklus: SCC size > 1, plus self-loop size 1.
 */
export function refreshCycles(db: DatabaseSync): Cycle[] {
  const { adj } = readAdj(db);  const comps = stronglyConnected(db);
  const cycles: number[][] = [];
  for (const c of comps) {
    if (c.length > 1) {
      cycles.push(c);
    } else if (c.length === 1 && (adj.get(c[0]) ?? []).includes(c[0])) {
      cycles.push(c); // self-loop
    }
  }
  try {
    db.prepare(`DELETE FROM cycles`).run();
  } catch {
    // ignore
  }
  const up = db.prepare(
    `INSERT INTO cycles(cycle_hash, length, nodes_json, created_at)
     VALUES (?, ?, ?, datetime('now'))
     ON CONFLICT(cycle_hash) DO UPDATE SET
       length = excluded.length, nodes_json = excluded.nodes_json`
  );
  const out: Cycle[] = [];
  for (const c of cycles) {
    const sorted = [...c].sort((a, b) => a - b);
    const h = hashIds(sorted);
    up.run(h, sorted.length, JSON.stringify(sorted));
    const row = db.prepare(`SELECT id FROM cycles WHERE cycle_hash = ?`).get(h) as { id: number };
    out.push({ id: row.id, hash: h, length: sorted.length, nodeIds: sorted });
  }
  return out;
}

export function getCycles(db: DatabaseSync, limit = 20): Cycle[] {
  try {
    const rows = db.prepare(
      `SELECT id, cycle_hash AS hash, length, nodes_json AS js FROM cycles ORDER BY length DESC LIMIT ${Math.max(1, Math.min(100, limit))}`
    ).all() as { id: number; hash: string; length: number; js: string }[];
    return rows.map((r) => {
      let nodeIds: number[] = [];
      try {
        nodeIds = JSON.parse(r.js) as number[];
      } catch {
        nodeIds = [];
      }
      return { id: r.id, hash: r.hash, length: r.length, nodeIds };
    });
  } catch {
    return [];
  }
}

/** Nama simbol dalam satu siklus (untuk pesan doctor/context). */
export function describeCycle(
  db: DatabaseSync,
  c: Cycle,
  limit = 8
): string {
  try {
    const names: string[] = [];
    for (const id of c.nodeIds.slice(0, limit)) {
      const r = db
        .prepare(`SELECT s.name AS n, f.path AS p FROM symbols s JOIN files f ON f.id = s.file_id WHERE s.id = ?`)
        .get(id) as { n: string; p: string } | undefined;
      if (r) names.push(`${r.n} (${r.p})`);
    }
    const more = c.nodeIds.length > limit ? ` +${c.nodeIds.length - limit} more` : "";
    return names.join(" → ") + more;
  } catch {
    return c.nodeIds.join(" → ");
  }
}

/** True bila simbol menjadi anggota siklus mana pun. */
export function nodeInCycle(db: DatabaseSync, nodeId: number): boolean {
  try {
    for (const c of getCycles(db, 100)) {
      if (c.nodeIds.includes(nodeId)) return true;
    }
    return false;
  } catch {
    return false;
  }
}
