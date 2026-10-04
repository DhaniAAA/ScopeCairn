// Uji beban sintetis: algoritma EXPAND lama (load semua edge) vs baru (BFS berlapis SQL).
// Jalankan: npx tsx scripts/loadtest.ts
// DB sintetis paritas: bobot proximity-only agar urutanering bisa dibandingkan persis.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { retrieve } from "../src/retrieval/retrieve.js";

function lcg(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return s / 2147483648;
  };
}

const WORDS = [
  "alpha", "bravo", "cargo", "delta", "engine", "fabric", "gateway",
  "harbor", "index", "jungle", "kernel", "ledger", "magnet", "north",
  "orbit", "panel", "quartz", "radar", "signal", "tower",
];

function buildDb(file: string, nSym: number, nEdges: number): void {
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE files (id INTEGER PRIMARY KEY, path TEXT UNIQUE, language TEXT, hash TEXT, size INTEGER);
    CREATE TABLE symbols (id INTEGER PRIMARY KEY, file_id INTEGER, name TEXT, type TEXT, signature TEXT, start_line INTEGER, end_line INTEGER);
    CREATE INDEX idx_symbols_file ON symbols(file_id);
    CREATE TABLE relationships (id INTEGER PRIMARY KEY, source_id INTEGER, target_id INTEGER, relationship_type TEXT, weight REAL, confidence REAL);
    CREATE INDEX idx_rel_source ON relationships(source_id);
    CREATE INDEX idx_rel_target ON relationships(target_id);
    CREATE VIRTUAL TABLE symbol_index USING fts5(symbol_id UNINDEXED, tokens);
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
  `);
  const rnd = lcg(42);
  db.exec("BEGIN");
  const insF = db.prepare(`INSERT INTO files(path, language, hash, size) VALUES (?, 'typescript', 'h', 100)`);
  const nFiles = Math.max(10, Math.floor(nSym / 50));
  for (let i = 0; i < nFiles; i++) insF.run(`src/mod${i}.ts`);
  const insS = db.prepare(
    `INSERT INTO symbols(file_id, name, type, signature, start_line, end_line) VALUES (?, ?, 'function', '', 1, 1)`
  );
  const insX = db.prepare(`INSERT INTO symbol_index(symbol_id, tokens) VALUES (?, ?)`);
  for (let i = 0; i < nSym; i++) {
    const w1 = WORDS[i % WORDS.length];
    const w2 = WORDS[Math.floor(rnd() * WORDS.length)];
    const name = `${w1}_${w2}_${i}`;
    const r = insS.run(1 + Math.floor(rnd() * nFiles), name);
    insX.run(Number(r.lastInsertRowid), `${w1} ${w2} function`);
  }
  const insR = db.prepare(
    `INSERT INTO relationships(source_id, target_id, relationship_type, weight, confidence) VALUES (?, ?, 'CALLS', 0.7, 0.7)`
  );
  for (let i = 0; i < nEdges; i++) {
    const a = 1 + Math.floor(rnd() * nSym);
    const b = 1 + Math.floor(rnd() * nSym);
    if (a !== b) insR.run(a, b);
  }
  db.exec("COMMIT");
  db.close();
}

// Replika algoritma lama: load SEMUA edge → adjacency Map → BFS JS.
function oldExpand(
  db: DatabaseSync,
  seeds: { symbolId: number; bm25: number }[],
  maxDepth: number,
  decay: number
): Map<number, number> {
  const proximity = new Map<number, number>();
  const visited = new Set<number>();
  let frontier = seeds.map((s) => s.symbolId);
  seeds.forEach((s) => {
    proximity.set(s.symbolId, Math.max(proximity.get(s.symbolId) ?? 0, s.bm25));
    visited.add(s.symbolId);
  });
  const adj = new Map<number, { to: number; w: number }[]>();
  for (const r of db.prepare(`SELECT source_id, target_id, weight FROM relationships`).all() as {
    source_id: number;
    target_id: number;
    weight: number;
  }[]) {
    if (!adj.has(r.source_id)) adj.set(r.source_id, []);
    adj.get(r.source_id)!.push({ to: r.target_id, w: r.weight });
    if (!adj.has(r.target_id)) adj.set(r.target_id, []);
    adj.get(r.target_id)!.push({ to: r.source_id, w: r.weight * 0.8 });
  }
  let hopScore = 1;
  for (let depth = 1; depth <= maxDepth; depth++) {
    hopScore *= decay;
    const next: number[] = [];
    for (const id of frontier) {
      const base = proximity.get(id) ?? 0;
      for (const e of adj.get(id) ?? []) {
        const cand = base * e.w * hopScore;
        if (cand > (proximity.get(e.to) ?? 0)) proximity.set(e.to, cand);
        if (!visited.has(e.to)) {
          visited.add(e.to);
          next.push(e.to);
        }
      }
    }
    frontier = next;
    if (frontier.length === 0) break;
  }
  return proximity;
}

function memMB(): number {
  return Math.round((process.memoryUsage().heapUsed / 1048576) * 10) / 10;
}

async function main(): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scload-"));
  const task = "alpha gateway radar";
  for (const edges of [20000, 100000]) {
    console.log(`membangun DB ${edges} edge...`);
    const nSym = Math.floor(edges / 10);
    const f = path.join(dir, `g${edges}.db`);
    buildDb(f, nSym, edges);
    const db = new DatabaseSync(f);

    // Seed identik untuk kedua algoritma.
    const { seedSearch } = await import("../src/retrieval/symbolIndex.js");
    const { tokenizeTask } = await import("../src/retrieval/tokenize.js");
    const seeds = seedSearch(db, tokenizeTask(task), 30);

    const m0 = memMB();
    const t0 = Date.now();
    const oldProx = oldExpand(db, seeds, 2, 0.7);
    const tOld = Date.now() - t0;
    const mOld = memMB() - m0;
    const oldOrder = [...oldProx.entries()]
      .filter(([, v]) => v > 0)
      .sort((a, b) => b[1] - a[1])
      .map(([id]) => id);

    const m1 = memMB();
    const t1 = Date.now();
    const res = retrieve(db, dir, task, {
      weights: { wSeed: 0, wProximity: 1, wCentrality: 0, wRecency: 0, wCochange: 0 },
      topN: 100000,
    });
    const tNew = Date.now() - t1;
    const mNew = memMB() - m1;
    // Paritas: pemetaan id→skor identik (urutan tie boleh beda — sort stabil).
    const newMap = new Map(res.ranked.map((r) => [r.id, r.score]));
    let setEq = oldProx.size === newMap.size;
    let maxDiff = 0;
    if (setEq) {
      for (const [id, v] of oldProx) {
        const nv = newMap.get(id);
        if (nv === undefined) {
          setEq = false;
          break;
        }
        maxDiff = Math.max(maxDiff, Math.abs(v - nv));
        if (maxDiff > 1e-9) {
          setEq = false;
          break;
        }
      }
    }
    const newOrder = res.ranked.map((r) => r.id);
    db.close();

    // (perbandingan dilakukan di atas via setEq/maxDiff)
    console.log(
      `edges=${edges} symbols=${nSym} | OLD ${tOld}ms +${mOld}MB | NEW ${tNew}ms +${mNew}MB | paritas=${setEq ? "IDENTIK" : "BEDA!"} (n=${newOrder.length}, maxDiff=${maxDiff})`
    );
    if (!setEq) {
      console.log(`  old[:5]=${oldOrder.slice(0, 5)} new[:5]=${newOrder.slice(0, 5)}`);
      process.exitCode = 1;
    }
  }
  fs.rmSync(dir, { recursive: true, force: true });
}

main();
