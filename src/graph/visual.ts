import type { DatabaseSync } from "node:sqlite";
import { ensureMetrics } from "./metrics.js";
import { ensureClusters } from "./clusters.js";

export const GRAPH_HTML_NAME = "GRAPH.html";
// Canvas menangani jauh lebih banyak node dibanding SVG statis lama.
const MAX_FILES = 600;
const MAX_EDGES = 1500;
const MAX_SYMBOLS = 800;
const MAX_SYM_EDGES = 2000;

interface VNode {
  id: number;
  file: string;
  lang: string;
  symbols: number;
  module: string;
  cluster: number;
  clusterName: string;
  pagerank: number;
  inDeg: number;
  outDeg: number;
  x: number;
  y: number;
  r: number;
  color: string;
}

interface VEdge {
  a: number;
  b: number;
  rel: string;
  n: number;
  conf: number;
}

export interface VSym {
  id: number;
  name: string;
  type: string;
  file: string;
  cluster: number;
  pr: number;
  inn: number;
  out: number;
  callers: string[];
  callees: string[];
  x: number;
  y: number;
}

export interface VSymEdge {
  s: number;
  t: number;
  rel: string;
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function moduleOf(file: string): string {
  const i = file.indexOf("/");
  return i === -1 ? "." : file.slice(0, i);
}

function colorFor(mod: string): string {
  let h = 0;
  for (const c of mod) h = (h * 31 + c.charCodeAt(0)) % 360;
  return `hsl(${h}, 55%, 55%)`;
}

export interface VisualModel {
  nodes: VNode[];
  edges: VEdge[];
  truncatedFiles: number;
  truncatedEdges: number;
  symbols: VSym[];
  symbolEdges: VSymEdge[];
  truncatedSymbols: number;
  clusterNames: { id: number; name: string }[];
  modularity: number;
}

// Subgraph overview: node = file, edge = relasi antar-file teragregasi.
// Anggaran: file top-N by derajat+simbol, edge top-N by jumlah.
export function buildVisualModel(db: DatabaseSync): VisualModel {
  const empty: VisualModel = {
    nodes: [], edges: [], truncatedFiles: 0, truncatedEdges: 0,
    symbols: [], symbolEdges: [], truncatedSymbols: 0, clusterNames: [], modularity: 0,
  };
  let files: { id: number; path: string; lang: string }[] = [];
  try {
    files = db.prepare(`SELECT id, path, language AS lang FROM files`).all() as {
      id: number;
      path: string;
      lang: string;
    }[];
  } catch {
    return empty;
  }
  if (files.length === 0) return empty;

  // Graphify Engine: metrik + komunitas dihitung malas (lazy) — scan pertama
  // mengisi cache, scan berikutnya hanya membaca bila graph tak berubah.
  let prBySym = new Map<number, number>();
  let clusterBySym = new Map<number, number>();
  const clusterNames = new Map<number, string>();
  let modularity = 0;
  try {
    ensureMetrics(db);
    for (const r of db.prepare(`SELECT node_id AS id, pagerank AS pr FROM node_metrics`).all() as {
      id: number; pr: number;
    }[]) prBySym.set(r.id, r.pr);
  } catch {
    // ignore — fallback ke derajat
  }
  try {
    ensureClusters(db);
    for (const r of db.prepare(
      `SELECT node_id AS id, cluster_id AS c, cluster_name AS n, modularity AS q FROM clusters`
    ).all() as { id: number; c: number; n: string; q: number }[]) {
      clusterBySym.set(r.id, r.c);
      if (r.n) clusterNames.set(r.c, r.n);
      modularity = r.q ?? modularity;
    }
  } catch {
    // ignore — fallback ke modul fisik
  }
  // Warna komunitas deterministik: cluster Louvain bila ada, else modul folder.
  const useClusters = clusterBySym.size > 0;

  const symCount = new Map<number, number>();
  try {
    for (const r of db
      .prepare(`SELECT file_id AS f, COUNT(*) AS n FROM symbols GROUP BY file_id`)
      .all() as { f: number; n: number }[]) {
      symCount.set(r.f, r.n);
    }
  } catch {
    // ignore
  }

  const deg = new Map<number, { inn: number; out: number }>();
  const pair = new Map<string, { a: number; b: number; rels: Map<string, { n: number; c: number }> }>();
  try {
    const rows = db.prepare(
      `SELECT s1.file_id AS fa, s2.file_id AS fb, r.relationship_type AS rel, r.confidence AS c
       FROM relationships r
       JOIN symbols s1 ON s1.id = r.source_id
       JOIN symbols s2 ON s2.id = r.target_id
       WHERE s1.file_id != s2.file_id`
    ).all() as { fa: number; fb: number; rel: string; c: number }[];
    for (const r of rows) {
      const d1 = deg.get(r.fa) ?? { inn: 0, out: 0 };
      d1.out++;
      deg.set(r.fa, d1);
      const d2 = deg.get(r.fb) ?? { inn: 0, out: 0 };
      d2.inn++;
      deg.set(r.fb, d2);
      const key = r.fa < r.fb ? `${r.fa}:${r.fb}` : `${r.fb}:${r.fa}`;
      let p = pair.get(key);
      if (!p) {
        p = { a: r.fa, b: r.fb, rels: new Map() };
        pair.set(key, p);
      }
      const e = p.rels.get(r.rel) ?? { n: 0, c: 0 };
      e.n++;
      e.c += r.c;
      p.rels.set(r.rel, e);
    }
  } catch {
    // ignore
  }

  const scored = files.map((f) => ({
    f,
    score: (deg.get(f.id)?.inn ?? 0) + (deg.get(f.id)?.out ?? 0) + (symCount.get(f.id) ?? 0) * 0.5,
  }));
  scored.sort((a, b) => b.score - a.score);
  const kept = scored.slice(0, MAX_FILES);
  const keptIds = new Set(kept.map((k) => k.f.id));
  const truncatedFiles = scored.length - kept.length;

  // Peta file → cluster dominan (mode komunitas simbol anggotanya).
  const fileCluster = new Map<number, number>();
  if (useClusters) {
    try {
      const rows = db.prepare(
        `SELECT file_id AS f, cluster_id AS c, COUNT(*) AS n FROM
           (SELECT s.file_id, c.cluster_id FROM symbols s JOIN clusters c ON c.node_id = s.id)
         GROUP BY file_id, cluster_id`
      ).all() as { f: number; c: number; n: number }[];
      const best = new Map<number, { c: number; n: number }>();
      for (const r of rows) {
        if (!keptIds.has(r.f)) continue;
        if ((best.get(r.f)?.n ?? -1) < r.n) best.set(r.f, { c: r.c, n: r.n });
      }
      for (const [f, v] of best) fileCluster.set(f, v.c);
    } catch {
      // ignore
    }
  }

  // PageRank per file = jumlah PR simbol anggotanya.
  const filePr = new Map<number, number>();
  if (prBySym.size > 0) {
    try {
      for (const r of db.prepare(
        `SELECT s.file_id AS f, SUM(m.pagerank) AS pr FROM symbols s
         JOIN node_metrics m ON m.node_id = s.id GROUP BY s.file_id`
      ).all() as { f: number; pr: number }[]) filePr.set(r.f, r.pr);
    } catch {
      // ignore
    }
  }

  const nodes: VNode[] = kept.map((k) => {
    const cid = fileCluster.get(k.f.id) ?? -1;
    const mod = moduleOf(k.f.path);
    return {
      id: k.f.id,
      file: k.f.path,
      lang: k.f.lang,
      symbols: symCount.get(k.f.id) ?? 0,
      module: mod,
      cluster: cid,
      clusterName: cid >= 0 ? (clusterNames.get(cid) ?? `cluster-${cid}`) : mod,
      pagerank: filePr.get(k.f.id) ?? 0,
      inDeg: deg.get(k.f.id)?.inn ?? 0,
      outDeg: deg.get(k.f.id)?.out ?? 0,
      x: 0,
      y: 0,
      r: 0,
      color: "",
    };
  });

  const edges: VEdge[] = [];
  for (const p of pair.values()) {
    if (!keptIds.has(p.a) || !keptIds.has(p.b)) continue;
    let top = "";
    let topN = 0;
    let confSum = 0;
    let total = 0;
    for (const [rel, e] of p.rels) {
      total += e.n;
      confSum += e.c;
      if (e.n > topN) {
        topN = e.n;
        top = rel;
      }
    }
    edges.push({ a: p.a, b: p.b, rel: top, n: total, conf: total > 0 ? confSum / total : 1 });
  }
  edges.sort((a, b) => b.n - a.n);
  const truncatedEdges = Math.max(0, edges.length - MAX_EDGES);
  const keptEdges = edges.slice(0, MAX_EDGES);

  layout(nodes, keptEdges);

  // ---- Lapisan simbol: top-N simbol by (fan-in + fan-out + PageRank). ----
  const { symbols, symbolEdges, truncatedSymbols } = buildSymbolLayer(
    db, keptIds, nodes, prBySym, clusterBySym
  );

  return {
    nodes, edges: keptEdges, truncatedFiles, truncatedEdges,
    symbols, symbolEdges, truncatedSymbols,
    clusterNames: [...clusterNames.entries()].map(([id, name]) => ({ id, name })),
    modularity,
  };
}

function buildSymbolLayer(
  db: DatabaseSync,
  keptFileIds: Set<number>,
  fileNodes: VNode[],
  prBySym: Map<number, number>,
  clusterBySym: Map<number, number>
): { symbols: VSym[]; symbolEdges: VSymEdge[]; truncatedSymbols: number } {
  const none = { symbols: [] as VSym[], symbolEdges: [] as VSymEdge[], truncatedSymbols: 0 };
  let rows: { id: number; name: string; type: string; file: string; fid: number; deg: number }[] = [];
  try {
    rows = db.prepare(
      `SELECT s.id, s.name, s.type, f.path AS file, s.file_id AS fid,
              (SELECT COUNT(*) FROM relationships r WHERE r.target_id = s.id) +
              (SELECT COUNT(*) FROM relationships r WHERE r.source_id = s.id) AS deg
       FROM symbols s JOIN files f ON f.id = s.file_id
       ORDER BY deg DESC LIMIT ${MAX_SYMBOLS * 2}`
    ).all() as typeof rows;
  } catch {
    return none;
  }
  rows = rows.filter((r) => keptFileIds.has(r.fid));
  // Boost PageRank: simbol penting walau derajat sedang tetap tampil.
  if (prBySym.size > 0) {
    rows.sort((a, b) => {
      const pa = (prBySym.get(a.id) ?? 0) * 100 + a.deg;
      const pb = (prBySym.get(b.id) ?? 0) * 100 + b.deg;
      return pb - pa;
    });
  }
  const truncatedSymbols = Math.max(0, rows.length - MAX_SYMBOLS);
  const kept = rows.slice(0, MAX_SYMBOLS);
  const keepIds = new Set(kept.map((r) => r.id));
  const byFile = new Map<number, VNode>();
  for (const n of fileNodes) byFile.set(n.id, n);
  const rnd = mulberry32(777);

  // Relasi antar simbol terpilih (untuk side panel + edge view).
  const callers = new Map<number, string[]>();
  const callees = new Map<number, string[]>();
  const symEdges: VSymEdge[] = [];
  try {
    const rels = db.prepare(
      `SELECT r.source_id AS s, r.target_id AS t, r.relationship_type AS rel,
              s1.name AS sn, s2.name AS tn
       FROM relationships r
       JOIN symbols s1 ON s1.id = r.source_id
       JOIN symbols s2 ON s2.id = r.target_id
       LIMIT 20000`
    ).all() as { s: number; t: number; rel: string; sn: string; tn: string }[];
    for (const r of rels) {
      if (keepIds.has(r.s) && keepIds.has(r.t)) {
        if (symEdges.length < MAX_SYM_EDGES) symEdges.push({ s: r.s, t: r.t, rel: r.rel });
      }
      if (keepIds.has(r.t) && (callers.get(r.t) ?? []).length < 8) {
        if (!callers.has(r.t)) callers.set(r.t, []);
        callers.get(r.t)!.push(`${r.sn} (${r.rel})`);
      }
      if (keepIds.has(r.s) && (callees.get(r.s) ?? []).length < 8) {
        if (!callees.has(r.s)) callees.set(r.s, []);
        callees.get(r.s)!.push(`${r.tn} (${r.rel})`);
      }
    }
  } catch {
    // ignore
  }

  const symbols: VSym[] = kept.map((r) => {
    const f = byFile.get(r.fid);
    const fx = f?.x ?? 500;
    const fy = f?.y ?? 380;
    return {
      id: r.id,
      name: r.name,
      type: r.type,
      file: r.file,
      cluster: clusterBySym.get(r.id) ?? -1,
      pr: prBySym.get(r.id) ?? 0,
      inn: 0,
      out: 0,
      callers: callers.get(r.id) ?? [],
      callees: callees.get(r.id) ?? [],
      x: Math.round(fx + (rnd() - 0.5) * 120),
      y: Math.round(fy + (rnd() - 0.5) * 120),
    };
  });
  const symById = new Map(symbols.map((s) => [s.id, s]));
  for (const e of symEdges) {
    const a = symById.get(e.s);
    const b = symById.get(e.t);
    if (a) a.out++;
    if (b) b.inn++;
  }
  return { symbols, symbolEdges: symEdges, truncatedSymbols };
}

// Layout force-directed deterministik (Fruchterman-Reingold + cluster modul),
// dihitung di Node saat generate. Browser hanya me-render koordinat final.
// Seed tetap → output bita-identik untuk graph yang sama.
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function layout(nodes: VNode[], edges: VEdge[]): void {
  for (const n of nodes) {
    n.color = colorFor(n.cluster >= 0 ? `cluster-${n.cluster}` : n.module);
    n.r = Math.min(15, 5 + Math.sqrt(n.symbols) * 1.6);
  }
  if (nodes.length === 0) return;
  if (nodes.length === 1) {
    nodes[0].x = 400;
    nodes[0].y = 300;
    return;
  }

  const rnd = mulberry32(1337);
  const groups = [...new Set(nodes.map((n) => (n.cluster >= 0 ? `c${n.cluster}` : n.module)))];
  const modAngle = new Map(groups.map((m, i) => [m, (i / groups.length) * Math.PI * 2]));
  const R0 = 260;
  const px = new Map<number, { x: number; y: number }>();
  const byId = new Map(nodes.map((n) => [n.id, n]));
  for (const n of nodes) {
    const key = n.cluster >= 0 ? `c${n.cluster}` : n.module;
    const a = (modAngle.get(key) ?? 0) + rnd() * 0.6;
    const r = R0 * (0.5 + rnd() * 0.7);
    px.set(n.id, { x: 500 + Math.cos(a) * r, y: 380 + Math.sin(a) * r * 0.75 });
  }

  const AREA = 1000 * 760;
  const k = Math.sqrt(AREA / nodes.length) * 0.9;
  const adj = new Map<number, { to: number; w: number }[]>();
  for (const e of edges) {
    const w = Math.min(2, 0.5 + e.n * 0.25);
    if (!adj.has(e.a)) adj.set(e.a, []);
    if (!adj.has(e.b)) adj.set(e.b, []);
    adj.get(e.a)!.push({ to: e.b, w });
    adj.get(e.b)!.push({ to: e.a, w });
  }

  const ITERS = 110;
  let temp = 90;
  const dTemp = Math.pow(0.5 / temp, 1 / ITERS);
  for (let it = 0; it < ITERS; it++) {
    const disp = new Map<number, { x: number; y: number }>();
    for (const n of nodes) disp.set(n.id, { x: 0, y: 0 });
    // Tolak-menolak antar semua pasangan.
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = px.get(nodes[i].id)!;
        const b = px.get(nodes[j].id)!;
        let dx = a.x - b.x;
        let dy = a.y - b.y;
        let d2 = dx * dx + dy * dy;
        if (d2 < 0.01) {
          dx = (rnd() - 0.5) * 2;
          dy = (rnd() - 0.5) * 2;
          d2 = dx * dx + dy * dy;
        }
        const d = Math.sqrt(d2);
        const f = Math.min((k * k) / d, temp * 2);
        const fx = (dx / d) * f;
        const fy = (dy / d) * f;
        const da = disp.get(nodes[i].id)!;
        const db2 = disp.get(nodes[j].id)!;
        da.x += fx;
        da.y += fy;
        db2.x -= fx;
        db2.y -= fy;
      }
    }
    // Pegas edge + gravitasi pusat + kohesi modul.
    for (const n of nodes) {
      const p = px.get(n.id)!;
      const d = disp.get(n.id)!;
      for (const e of adj.get(n.id) ?? []) {
        const q = px.get(e.to);
        if (!q) continue;
        const dx = p.x - q.x;
        const dy = p.y - q.y;
        const dist = Math.max(1, Math.sqrt(dx * dx + dy * dy));
        const f = ((dist * dist) / k) * 0.02 * e.w;
        d.x -= (dx / dist) * f;
        d.y -= (dy / dist) * f;
      }
      // Gravitasi ke pusat agar tak hanyut.
      d.x += (500 - p.x) * 0.03;
      d.y += (380 - p.y) * 0.03;
    }
    // Kohesi modul: tarik ke centroid modulnya.
    const cent = new Map<string, { x: number; y: number; n: number }>();
    for (const n of nodes) {
      const key = n.cluster >= 0 ? `c${n.cluster}` : n.module;
      const p = px.get(n.id)!;
      const c = cent.get(key) ?? { x: 0, y: 0, n: 0 };
      c.x += p.x;
      c.y += p.y;
      c.n++;
      cent.set(key, c);
    }
    for (const n of nodes) {
      const key = n.cluster >= 0 ? `c${n.cluster}` : n.module;
      const c = cent.get(key)!;
      const p = px.get(n.id)!;
      const d = disp.get(n.id)!;
      d.x += (c.x / c.n - p.x) * 0.05;
      d.y += (c.y / c.n - p.y) * 0.05;
    }
    for (const n of nodes) {
      const p = px.get(n.id)!;
      const d = disp.get(n.id)!;
      const dl = Math.max(0.001, Math.sqrt(d.x * d.x + d.y * d.y));
      const step = Math.min(dl, temp);
      p.x += (d.x / dl) * step;
      p.y += (d.y / dl) * step;
    }
    temp *= dTemp;
  }
  for (const n of nodes) {
    const p = px.get(n.id)!;
    n.x = Math.round(p.x);
    n.y = Math.round(p.y);
  }
  void byId;
}

export function renderHtml(model: VisualModel, title: string, generated: string): string {
  // Data grafik ditanam sebagai JSON (lolos `<` → \u003c agar aman di <script>).
  const payload = JSON.stringify({
    files: model.nodes.map((n) => ({
      id: n.id, file: n.file, lang: n.lang, symbols: n.symbols, module: n.module,
      cluster: n.cluster, clusterName: n.clusterName, pr: n.pagerank,
      inn: n.inDeg, out: n.outDeg, x: n.x, y: n.y, r: n.r, color: n.color,
    })),
    edges: model.edges,
    symbols: model.symbols,
    symbolEdges: model.symbolEdges,
    clusters: model.clusterNames,
    modularity: model.modularity,
    truncated: {
      files: model.truncatedFiles, edges: model.truncatedEdges, symbols: model.truncatedSymbols,
    },
  }).replace(/</g, "\\u003c");

  const truncNote =
    model.truncatedFiles > 0 || model.truncatedSymbols > 0
      ? ` (+${model.truncatedFiles} files, +${model.truncatedSymbols} symbols beyond budget)`
      : "";
  const clusterNote =
    model.clusterNames.length > 0
      ? `${model.clusterNames.length} communities · Q=${model.modularity.toFixed(3)}`
      : "";

  return `<!DOCTYPE html>
<html lang="en" data-theme="dark">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} — ScopeCairn Knowledge Explorer</title>
<style>
:root {
  --bg: #090d16;
  --bg-dots: rgba(255, 255, 255, 0.04);
  --panel: rgba(15, 23, 42, 0.82);
  --panel-solid: #0f172a;
  --line: rgba(255, 255, 255, 0.09);
  --line-strong: rgba(255, 255, 255, 0.18);
  --ink: #f8fafc;
  --mut: #94a3b8;
  --acc: #38bdf8;
  --acc-glow: rgba(56, 189, 248, 0.35);
  --acc-active: #0ea5e9;
  --card-bg: rgba(30, 41, 59, 0.6);
  --badge-bg: rgba(255, 255, 255, 0.08);
  --shadow: 0 16px 36px -4px rgba(0, 0, 0, 0.55), 0 0 0 1px var(--line);
}
[data-theme="light"] {
  --bg: #f8fafc;
  --bg-dots: rgba(0, 0, 0, 0.04);
  --panel: rgba(255, 255, 255, 0.88);
  --panel-solid: #ffffff;
  --line: rgba(0, 0, 0, 0.08);
  --line-strong: rgba(0, 0, 0, 0.16);
  --ink: #0f172a;
  --mut: #64748b;
  --acc: #0284c7;
  --acc-glow: rgba(2, 132, 199, 0.25);
  --acc-active: #0369a1;
  --card-bg: rgba(241, 245, 249, 0.85);
  --badge-bg: rgba(0, 0, 0, 0.06);
  --shadow: 0 16px 36px -4px rgba(0, 0, 0, 0.08), 0 0 0 1px var(--line);
}
* { box-sizing: border-box; }
body {
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  margin: 0;
  background: var(--bg);
  color: var(--ink);
  overflow: hidden;
  height: 100vh;
  display: flex;
  flex-direction: column;
}
header {
  padding: 10px 16px;
  background: var(--panel);
  backdrop-filter: blur(20px);
  -webkit-backdrop-filter: blur(20px);
  border-bottom: 1px solid var(--line);
  z-index: 10;
  display: flex;
  flex-direction: column;
  gap: 8px;
  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.15);
}
.header-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}
.brand-group {
  display: flex;
  align-items: center;
  gap: 10px;
}
.brand-icon {
  width: 28px;
  height: 28px;
  border-radius: 8px;
  background: linear-gradient(135deg, #0ea5e9, #8b5cf6);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 15px;
  box-shadow: 0 0 12px var(--acc-glow);
}
.brand-title {
  font-size: 15px;
  font-weight: 700;
  letter-spacing: -0.01em;
  display: flex;
  align-items: center;
  gap: 8px;
}
.brand-meta {
  font-size: 11.5px;
  color: var(--mut);
}
.stats-badges {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}
.badge {
  background: var(--badge-bg);
  border: 1px solid var(--line);
  border-radius: 6px;
  padding: 3px 8px;
  font-size: 11.5px;
  font-weight: 500;
  color: var(--mut);
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.badge strong {
  color: var(--ink);
  font-weight: 600;
}
.badge.accent {
  background: var(--acc-glow);
  color: var(--acc);
  border-color: rgba(56, 189, 248, 0.3);
}
.top-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-left: auto;
}
.btn-icon {
  background: var(--card-bg);
  border: 1px solid var(--line);
  color: var(--ink);
  border-radius: 8px;
  padding: 6px 10px;
  font-size: 12.5px;
  font-weight: 500;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  transition: all .15s ease;
}
.btn-icon:hover {
  background: var(--line-strong);
  border-color: var(--acc);
  color: var(--acc);
}
#bar {
  display: flex;
  gap: 8px;
  align-items: center;
  flex-wrap: wrap;
}
.seg {
  display: inline-flex;
  background: var(--card-bg);
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 2px;
  gap: 2px;
}
.seg button {
  border: 0;
  background: transparent;
  color: var(--mut);
  padding: 5px 12px;
  font-size: 12px;
  font-weight: 600;
  border-radius: 6px;
  cursor: pointer;
  transition: all .15s ease;
  display: inline-flex;
  align-items: center;
  gap: 5px;
}
.seg button:hover {
  color: var(--ink);
}
.seg button.on {
  background: var(--acc);
  color: #fff;
  box-shadow: 0 2px 8px var(--acc-glow);
}
.search-wrapper {
  position: relative;
  flex: 1;
  min-width: 200px;
  max-width: 340px;
}
.search-wrapper input {
  width: 100%;
  padding: 6px 30px 6px 28px;
  font-size: 12.5px;
  background: var(--card-bg);
  border: 1px solid var(--line);
  border-radius: 8px;
  color: var(--ink);
  outline: none;
  transition: border-color .15s ease;
}
.search-wrapper input:focus {
  border-color: var(--acc);
  box-shadow: 0 0 0 3px var(--acc-glow);
}
.search-icon {
  position: absolute;
  left: 8px;
  top: 50%;
  transform: translateY(-50%);
  font-size: 12px;
  color: var(--mut);
  pointer-events: none;
}
.search-kbd {
  position: absolute;
  right: 6px;
  top: 50%;
  transform: translateY(-50%);
  font-size: 10px;
  color: var(--mut);
  background: var(--badge-bg);
  border: 1px solid var(--line);
  border-radius: 4px;
  padding: 1px 4px;
  pointer-events: none;
}
#bar select {
  padding: 6px 10px;
  font-size: 12.5px;
  background: var(--card-bg);
  border: 1px solid var(--line);
  border-radius: 8px;
  color: var(--ink);
  outline: none;
  cursor: pointer;
}
#bar select:focus {
  border-color: var(--acc);
}
#main {
  flex: 1;
  display: flex;
  position: relative;
  overflow: hidden;
}
#wrap {
  flex: 1;
  position: relative;
  overflow: hidden;
  cursor: grab;
  background: radial-gradient(circle at 50% 50%, var(--bg) 0%, #05070c 100%);
}
[data-theme="light"] #wrap {
  background: radial-gradient(circle at 50% 50%, var(--bg) 0%, #edf2f7 100%);
}
#cv {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
}
#hud {
  position: absolute;
  right: 18px;
  bottom: 18px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  z-index: 5;
}
.hud-btn {
  width: 36px;
  height: 36px;
  border-radius: 10px;
  background: var(--panel);
  backdrop-filter: blur(12px);
  border: 1px solid var(--line);
  color: var(--ink);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 15px;
  cursor: pointer;
  box-shadow: var(--shadow);
  transition: all .15s ease;
}
.hud-btn:hover {
  background: var(--line-strong);
  color: var(--acc);
  transform: scale(1.05);
}
#minimap-panel {
  position: absolute;
  left: 18px;
  bottom: 18px;
  background: var(--panel);
  backdrop-filter: blur(16px);
  border: 1px solid var(--line);
  border-radius: 12px;
  padding: 6px;
  box-shadow: var(--shadow);
  z-index: 5;
  transition: opacity .2s ease, transform .2s ease;
}
#minimap-panel.hidden {
  opacity: 0;
  pointer-events: none;
  transform: translateY(10px);
}
#minimap-title {
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
  color: var(--mut);
  letter-spacing: .05em;
  padding: 2px 4px 4px;
}
#minimap {
  display: block;
  width: 160px;
  height: 110px;
  background: rgba(0, 0, 0, 0.25);
  border-radius: 8px;
  cursor: pointer;
}
#banner-focus {
  position: absolute;
  top: 14px;
  left: 50%;
  transform: translateX(-50%);
  background: var(--panel);
  backdrop-filter: blur(16px);
  border: 1px solid var(--acc);
  box-shadow: 0 4px 20px var(--acc-glow);
  padding: 6px 14px;
  border-radius: 20px;
  font-size: 12px;
  color: var(--ink);
  display: none;
  align-items: center;
  gap: 10px;
  z-index: 5;
}
#banner-focus .btn-reset {
  background: var(--badge-bg);
  border: 1px solid var(--line);
  border-radius: 12px;
  color: var(--mut);
  font-size: 11px;
  padding: 2px 8px;
  cursor: pointer;
}
#banner-focus .btn-reset:hover {
  color: var(--ink);
}
#side {
  width: 340px;
  max-width: 42vw;
  background: var(--panel);
  backdrop-filter: blur(20px);
  border-left: 1px solid var(--line);
  display: flex;
  flex-direction: column;
  z-index: 6;
  box-shadow: -8px 0 24px rgba(0, 0, 0, 0.2);
  transition: transform .25s cubic-bezier(0.16, 1, 0.3, 1), margin-right .25s ease;
}
#side.collapsed {
  margin-right: -340px;
  transform: translateX(100%);
}
.side-header {
  padding: 14px 16px;
  border-bottom: 1px solid var(--line);
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 10px;
}
.side-header h2 {
  font-size: 14.5px;
  font-weight: 700;
  margin: 0 0 4px;
  word-break: break-all;
  line-height: 1.3;
}
.side-close {
  background: transparent;
  border: 0;
  color: var(--mut);
  font-size: 16px;
  cursor: pointer;
  padding: 2px 6px;
  border-radius: 4px;
}
.side-close:hover {
  background: var(--line);
  color: var(--ink);
}
.side-content {
  flex: 1;
  overflow-y: auto;
  padding: 14px 16px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.meta-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--mut);
}
.metrics-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
}
.metric-card {
  background: var(--card-bg);
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 8px 10px;
}
.metric-card .val {
  font-size: 16px;
  font-weight: 700;
  color: var(--ink);
}
.metric-card .lbl {
  font-size: 10.5px;
  text-transform: uppercase;
  color: var(--mut);
  letter-spacing: .04em;
  margin-top: 2px;
}
.section-title {
  font-size: 11px;
  text-transform: uppercase;
  font-weight: 700;
  letter-spacing: .06em;
  color: var(--mut);
  margin: 0 0 6px;
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.chip-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.node-chip {
  background: var(--card-bg);
  border: 1px solid var(--line);
  border-radius: 6px;
  padding: 6px 8px;
  font-size: 12px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  cursor: pointer;
  transition: all .15s ease;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}
.node-chip:hover {
  border-color: var(--acc);
  background: var(--acc-glow);
  color: var(--acc);
  transform: translateX(2px);
}
.node-chip .rel-tag {
  font-size: 10px;
  padding: 1px 5px;
  border-radius: 4px;
  background: var(--badge-bg);
  color: var(--mut);
}
#tip {
  position: fixed;
  display: none;
  background: rgba(15, 23, 42, 0.92);
  backdrop-filter: blur(12px);
  color: #fff;
  font: 12px ui-monospace, SFMono-Regular, Menlo, monospace;
  padding: 6px 10px;
  border-radius: 8px;
  border: 1px solid var(--acc);
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.5), 0 0 10px var(--acc-glow);
  pointer-events: none;
  white-space: pre;
  z-index: 20;
  max-width: 70vw;
}
#modal-shortcuts {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.65);
  backdrop-filter: blur(8px);
  z-index: 100;
  display: none;
  align-items: center;
  justify-content: center;
}
.modal-box {
  background: var(--panel-solid);
  border: 1px solid var(--line-strong);
  border-radius: 14px;
  width: 90%;
  max-width: 440px;
  padding: 20px;
  box-shadow: var(--shadow);
}
.modal-box h3 {
  margin: 0 0 14px;
  font-size: 16px;
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.shortcut-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 6px 0;
  border-bottom: 1px solid var(--line);
  font-size: 13px;
}
kbd {
  background: var(--badge-bg);
  border: 1px solid var(--line);
  border-radius: 4px;
  padding: 2px 6px;
  font-family: ui-monospace, monospace;
  font-size: 11px;
}
</style>
</head>
<body>
<header>
  <div class="header-top">
    <div class="brand-group">
      <div class="brand-icon">⬡</div>
      <div>
        <div class="brand-title">${esc(title)}</div>
        <div class="brand-meta">Generated by <code>scopecairn scan</code> · ${esc(generated)}</div>
      </div>
    </div>
    <div class="stats-badges">
      <div class="badge"><strong>${model.nodes.length}</strong> Files</div>
      <div class="badge"><strong>${model.symbols.length}</strong> Symbols</div>
      <div class="badge"><strong>${model.edges.length}</strong> Links</div>
      ${model.clusterNames.length > 0 ? `<div class="badge accent"><strong>${model.clusterNames.length}</strong> Communities (Q=${model.modularity.toFixed(3)})</div>` : ""}
      ${truncNote ? `<div class="badge" title="Budget limit">${esc(truncNote)}</div>` : ""}
    </div>
    <div class="top-actions">
      <button class="btn-icon" id="btn-theme" title="Toggle theme">🌙 Theme</button>
      <button class="btn-icon" id="btn-shortcuts" title="Keyboard shortcuts">⌨️</button>
      <button class="btn-icon" id="btn-side-toggle" title="Toggle inspector">◨ Panel</button>
    </div>
  </div>
  <div id="bar">
    <div class="seg" role="tablist">
      <button data-mode="cluster" class="on">Communities</button>
      <button data-mode="file">Files</button>
      <button data-mode="symbol">Symbols</button>
    </div>
    <div class="search-wrapper">
      <span class="search-icon">🔍</span>
      <input id="q" placeholder="Search node, module, type…" autocomplete="off">
      <span class="search-kbd">/</span>
    </div>
    <select id="tf">
      <option value="">All Types</option>
      <option value="function">function</option>
      <option value="class">class</option>
      <option value="method">method</option>
      <option value="route">route</option>
      <option value="model">model</option>
      <option value="component">component</option>
      <option value="interface">interface</option>
      <option value="type">type</option>
    </select>
    <select id="ef">
      <option value="">All Relations</option>
      <option value="CALLS">CALLS</option>
      <option value="IMPORTS">IMPORTS</option>
      <option value="EXPORTS">EXPORTS</option>
      <option value="TESTS">TESTS</option>
      <option value="EXTENDS">EXTENDS</option>
    </select>
    <button class="btn-icon" id="fit">⛶ Fit View</button>
  </div>
</header>

<div id="main">
  <div id="wrap">
    <canvas id="cv"></canvas>

    <div id="banner-focus">
      <span id="focus-text">🎯 Focused on target</span>
      <button class="btn-reset" id="btn-clear-focus">Reset</button>
    </div>

    <div id="minimap-panel">
      <div id="minimap-title">Mini Map</div>
      <canvas id="minimap"></canvas>
    </div>

    <div id="hud">
      <button class="hud-btn" id="hud-zoom-in" title="Zoom in">+</button>
      <button class="hud-btn" id="hud-zoom-out" title="Zoom out">−</button>
      <button class="hud-btn" id="hud-fit" title="Fit to screen">⛶</button>
      <button class="hud-btn" id="hud-map-toggle" title="Toggle minimap">🗺️</button>
    </div>
  </div>

  <aside id="side">
    <div class="side-header">
      <div>
        <h2 id="side-title">ScopeCairn Inspector</h2>
        <div class="meta-chip" id="side-sub">Click node to inspect dependencies</div>
      </div>
      <button class="side-close" id="side-close-btn">✕</button>
    </div>
    <div class="side-content" id="side-body">
      <div class="metric-card" style="text-align:center;padding:24px 10px;">
        <div style="font-size:24px;margin-bottom:8px;">🎯</div>
        <div style="font-size:13px;font-weight:600;margin-bottom:4px;">No Selection</div>
        <div style="font-size:11.5px;color:var(--mut);">Click on any node to isolate its connections, view centrality scores, and inspect callers & callees.</div>
      </div>
    </div>
  </aside>
</div>

<div id="tip"></div>

<div id="modal-shortcuts">
  <div class="modal-box">
    <h3>Keyboard Shortcuts <button class="side-close" id="modal-close-btn">✕</button></h3>
    <div class="shortcut-row"><span>Search node</span><kbd>/</kbd></div>
    <div class="shortcut-row"><span>Clear search / Unselect</span><kbd>Esc</kbd></div>
    <div class="shortcut-row"><span>Switch to Community view</span><kbd>1</kbd></div>
    <div class="shortcut-row"><span>Switch to File view</span><kbd>2</kbd></div>
    <div class="shortcut-row"><span>Switch to Symbol view</span><kbd>3</kbd></div>
    <div class="shortcut-row"><span>Fit graph in view</span><kbd>F</kbd></div>
    <div class="shortcut-row"><span>Zoom in / Zoom out</span><kbd>+</kbd> / <kbd>-</kbd></div>
    <div class="shortcut-row"><span>Pan canvas</span><kbd>Drag</kbd></div>
    <div class="shortcut-row"><span>Center & inspect node</span><kbd>Double Click</kbd></div>
  </div>
</div>

<script>
(function(){
"use strict";
var DATA = ${payload};
var files = DATA.files, fedges = DATA.edges, syms = DATA.symbols, sedges = DATA.symbolEdges;
var byFileId = {}, bySymId = {};
files.forEach(function(n){ byFileId[n.id] = n; });
syms.forEach(function(s){ bySymId[s.id] = s; });

// Adjacency maps for instant neighbor highlighting
var fileAdj = {}, symAdj = {};
fedges.forEach(function(e){
  if (!fileAdj[e.a]) fileAdj[e.a] = new Set();
  if (!fileAdj[e.b]) fileAdj[e.b] = new Set();
  fileAdj[e.a].add(e.b);
  fileAdj[e.b].add(e.a);
});
sedges.forEach(function(e){
  if (!symAdj[e.s]) symAdj[e.s] = new Set();
  if (!symAdj[e.t]) symAdj[e.t] = new Set();
  symAdj[e.s].add(e.t);
  symAdj[e.t].add(e.s);
});

// Community clusters
var clusters = [];
(function(){
  var m = {};
  files.forEach(function(n){
    var key = n.cluster >= 0 ? ("c" + n.cluster) : ("m:" + n.module);
    if (!m[key]) m[key] = { key: key, cluster: n.cluster, name: n.cluster >= 0 ? n.clusterName : n.module, members: [], x: 0, y: 0, r: 0 };
    m[key].members.push(n);
  });
  Object.keys(m).forEach(function(k){
    var c = m[k], sx = 0, sy = 0;
    c.members.forEach(function(n){ sx += n.x; sy += n.y; });
    c.x = sx / c.members.length;
    c.y = sy / c.members.length;
    c.r = Math.min(50, 16 + Math.sqrt(c.members.length) * 6);
    clusters.push(c);
  });
})();

var cv = document.getElementById('cv'), ctx = cv.getContext('2d'), wrap = document.getElementById('wrap');
var miniCv = document.getElementById('minimap'), miniCtx = miniCv.getContext('2d');
var side = document.getElementById('side'), tip = document.getElementById('tip');
var bannerFocus = document.getElementById('banner-focus'), focusText = document.getElementById('focus-text');
var mode = 'cluster', query = '', typeF = '', relF = '';
var cam = { x: 0, y: 0, scale: 1 }, drag = null, hover = null, sel = null, dpr = 1;
var darkTheme = true;

function isDark() {
  return document.documentElement.getAttribute('data-theme') === 'dark';
}

function resize(){
  dpr = Math.min(2, window.devicePixelRatio || 1);
  var r = wrap.getBoundingClientRect();
  cv.width = Math.max(1, r.width * dpr);
  cv.height = Math.max(1, r.height * dpr);
  miniCv.width = 160 * dpr;
  miniCv.height = 110 * dpr;
  draw();
}
window.addEventListener('resize', resize);

function match(n){
  if (typeF && (n.type || '') !== typeF) return false;
  if (!query) return true;
  var hay = ((n.name || n.file || '') + ' ' + (n.type || '') + ' ' + (n.module || '') + ' ' + (n.clusterName || '')).toLowerCase();
  return hay.indexOf(query) >= 0;
}

function currentPoints(){
  if (mode === 'symbol') return syms.filter(match);
  if (mode === 'file') return files.filter(match);
  return clusters;
}

function fit(){
  var pts = currentPoints();
  if (!pts.length) { cam = { x: 0, y: 0, scale: 1 }; draw(); return; }
  var xs = pts.map(function(p){ return p.x; }), ys = pts.map(function(p){ return p.y; });
  var x0 = Math.min.apply(0, xs) - 80, x1 = Math.max.apply(0, xs) + 80;
  var y0 = Math.min.apply(0, ys) - 80, y1 = Math.max.apply(0, ys) + 80;
  var r = wrap.getBoundingClientRect();
  var s = Math.min(r.width / (x1 - x0), r.height / (y1 - y0));
  s = Math.min(3.5, Math.max(0.06, s));
  cam.scale = s;
  cam.x = x0 - (r.width / s - (x1 - x0)) / 2;
  cam.y = y0 - (r.height / s - (y1 - y0)) / 2;
  draw();
}

function zoomAt(mx, my, factor){
  var s0 = cam.scale;
  var s1 = Math.min(12, Math.max(0.04, s0 * factor));
  if (s1 === s0) return;
  cam.x = mx - (mx - cam.x) * (s1 / s0);
  cam.y = my - (my - cam.y) * (s1 / s0);
  cam.scale = s1;
  draw();
}

function centerOn(x, y, targetScale){
  var r = wrap.getBoundingClientRect();
  var s = targetScale || Math.max(cam.scale, 1.2);
  cam.scale = s;
  cam.x = x - (r.width / (2 * s));
  cam.y = y - (r.height / (2 * s));
  draw();
}

// Edge colors by relationship type
function edgeColor(rel, active, conf) {
  var dark = isDark();
  if (!active) return dark ? 'rgba(148, 163, 184, 0.12)' : 'rgba(100, 116, 139, 0.15)';
  if (rel === 'CALLS') return '#ec4899';
  if (rel === 'IMPORTS') return '#38bdf8';
  if (rel === 'EXPORTS') return '#f59e0b';
  if (rel === 'TESTS') return '#10b981';
  if (rel === 'EXTENDS') return '#a855f7';
  return dark ? '#94a3b8' : '#475569';
}

function drawMinimap() {
  var W = miniCv.width, H = miniCv.height;
  miniCtx.clearRect(0, 0, W, H);
  var pts = currentPoints();
  if (!pts.length) return;
  var xs = pts.map(function(p){ return p.x; }), ys = pts.map(function(p){ return p.y; });
  var x0 = Math.min.apply(0, xs) - 40, x1 = Math.max.apply(0, xs) + 40;
  var y0 = Math.min.apply(0, ys) - 40, y1 = Math.max.apply(0, ys) + 40;
  var gw = Math.max(10, x1 - x0), gh = Math.max(10, y1 - y0);
  var s = Math.min(W / gw, H / gh) * 0.9;
  var ox = (W - gw * s) / 2, oy = (H - gh * s) / 2;

  // Draw node dots
  miniCtx.fillStyle = isDark() ? 'rgba(148, 163, 184, 0.45)' : 'rgba(100, 116, 139, 0.5)';
  pts.forEach(function(p){
    var mx = (p.x - x0) * s + ox, my = (p.y - y0) * s + oy;
    miniCtx.fillRect(mx - 1, my - 1, 2.5, 2.5);
  });

  // Draw viewport rectangle
  var r = wrap.getBoundingClientRect();
  var vx0 = (cam.x - x0) * s + ox;
  var vy0 = (cam.y - y0) * s + oy;
  var vw = (r.width / cam.scale) * s;
  var vh = (r.height / cam.scale) * s;
  miniCtx.strokeStyle = '#38bdf8';
  miniCtx.lineWidth = 1.5;
  miniCtx.strokeRect(vx0, vy0, vw, vh);
  miniCtx.fillStyle = 'rgba(56, 189, 248, 0.15)';
  miniCtx.fillRect(vx0, vy0, vw, vh);
}

function draw(){
  var r = wrap.getBoundingClientRect(), W = r.width * dpr, H = r.height * dpr;
  ctx.clearRect(0, 0, W, H);
  var dark = isDark();

  // Subtle grid points in dark mode
  var s = cam.scale * dpr, ox = -cam.x * s, oy = -cam.y * s;
  function X(x){ return x * s + ox; }
  function Y(y){ return y * s + oy; }

  // Neighbor set for isolation mode
  var activeNeighbors = null;
  if (sel) {
    activeNeighbors = new Set();
    if (sel.kind === 'file') {
      activeNeighbors.add(sel.id);
      var nbrs = fileAdj[sel.id];
      if (nbrs) nbrs.forEach(function(id){ activeNeighbors.add(id); });
    } else if (sel.kind === 'symbol') {
      activeNeighbors.add(sel.id);
      var nbrs = symAdj[sel.id];
      if (nbrs) nbrs.forEach(function(id){ activeNeighbors.add(id); });
    }
  }

  ctx.lineWidth = 1;

  if (mode === 'cluster') {
    // Cluster View
    clusters.forEach(function(c){
      var isSel = (sel && sel.kind === 'cluster' && sel.key === c.key);
      var isH = (hover && hover.kind === 'cluster' && hover.key === c.key);
      var rad = Math.max(6, c.r * s);

      // Outer hull glow
      ctx.beginPath();
      ctx.arc(X(c.x), Y(c.y), rad * 1.6, 0, 2 * Math.PI);
      ctx.fillStyle = isSel ? 'rgba(56, 189, 248, 0.2)' : 'rgba(56, 189, 248, 0.05)';
      ctx.fill();

      // Core bubble
      ctx.beginPath();
      ctx.arc(X(c.x), Y(c.y), rad, 0, 2 * Math.PI);
      ctx.fillStyle = isSel ? '#0ea5e9' : isH ? '#38bdf8' : (dark ? '#334155' : '#64748b');
      ctx.fill();
      ctx.strokeStyle = isSel ? '#fff' : (dark ? '#475569' : '#cbd5e1');
      ctx.lineWidth = (isSel ? 3 : 1.5) * dpr;
      ctx.stroke();

      // Label with badge count
      ctx.fillStyle = isSel ? '#38bdf8' : (dark ? '#f1f5f9' : '#0f172a');
      ctx.font = 'bold ' + Math.max(10, Math.min(14, 12 * dpr)) + 'px system-ui';
      ctx.textAlign = 'center';
      ctx.fillText(c.name + ' (' + c.members.length + ')', X(c.x), Y(c.y) - rad - 8 * dpr);
    });
  } else if (mode === 'file') {
    // File Network
    fedges.forEach(function(e){
      var a = byFileId[e.a], b = byFileId[e.b];
      if (!a || !b || !match(a) || !match(b)) return;
      if (relF && e.rel !== relF) return;

      var isEdgeActive = !sel || (sel.kind === 'file' && (sel.id === a.id || sel.id === b.id));
      if (sel && !isEdgeActive) return; // Hide non-connected edges in focus mode

      ctx.beginPath();
      ctx.moveTo(X(a.x), Y(a.y));
      ctx.lineTo(X(b.x), Y(b.y));
      ctx.strokeStyle = edgeColor(e.rel, isEdgeActive, e.conf);
      ctx.setLineDash(e.conf < 0.8 ? [5, 4] : []);
      ctx.lineWidth = (isEdgeActive && sel ? 2.5 : Math.min(3, 0.6 + e.n * 0.4)) * dpr;
      ctx.stroke();
      ctx.setLineDash([]);
    });

    files.forEach(function(n){
      if (!match(n)) return;
      var isDirect = !activeNeighbors || activeNeighbors.has(n.id);
      var isH = hover && hover.kind === 'file' && hover.id === n.id;
      var isS = sel && sel.kind === 'file' && sel.id === n.id;
      var rad = Math.max(3, n.r * s);

      ctx.save();
      if (!isDirect) ctx.globalAlpha = 0.12;

      ctx.beginPath();
      ctx.arc(X(n.x), Y(n.y), rad + (isH ? 3 : 0), 0, 2 * Math.PI);
      ctx.fillStyle = n.color || '#38bdf8';
      ctx.fill();

      if (isS || isH) {
        ctx.shadowColor = '#38bdf8';
        ctx.shadowBlur = 15;
      }
      ctx.lineWidth = (isS ? 3.5 : isH ? 2.5 : 1.2) * dpr;
      ctx.strokeStyle = isS ? '#fff' : (dark ? 'rgba(255,255,255,0.7)' : '#1e293b');
      ctx.stroke();

      // Show labels for top nodes or on hover/select
      if ((isS || isH || (isDirect && s > 0.45))) {
        ctx.fillStyle = isS ? '#38bdf8' : (dark ? '#f8fafc' : '#0f172a');
        ctx.font = (11 * dpr) + 'px ui-monospace, monospace';
        ctx.textAlign = 'left';
        var parts = n.file.split('/');
        var label = parts.length > 2 ? (parts[0] + '/…/' + parts[parts.length - 1]) : n.file;
        ctx.fillText(label, X(n.x) + rad + 6 * dpr, Y(n.y) + 4 * dpr);
      }
      ctx.restore();
    });
  } else {
    // Symbol Network
    var se = {};
    sedges.forEach(function(e){
      var a = bySymId[e.s], b = bySymId[e.t];
      if (!a || !b || !match(a) || !match(b)) return;
      if (relF && e.rel !== relF) return;

      var isEdgeActive = !sel || (sel.kind === 'symbol' && (sel.id === a.id || sel.id === b.id));
      if (sel && !isEdgeActive) return;

      var k = e.s + ':' + e.t;
      if (se[k]) return;
      se[k] = 1;

      ctx.beginPath();
      ctx.moveTo(X(a.x), Y(a.y));
      ctx.lineTo(X(b.x), Y(b.y));
      ctx.strokeStyle = edgeColor(e.rel, isEdgeActive, 1.0);
      ctx.lineWidth = (isEdgeActive && sel ? 2.2 : 1) * dpr;
      ctx.stroke();
    });

    syms.forEach(function(n){
      if (!match(n)) return;
      var isDirect = !activeNeighbors || activeNeighbors.has(n.id);
      var isH = hover && hover.kind === 'symbol' && hover.id === n.id;
      var isS = sel && sel.kind === 'symbol' && sel.id === n.id;
      var base = 4.5 + Math.min(10, Math.sqrt(n.inn + n.out) * 2 + (n.pr * 350));
      var rad = Math.max(3, base * s);

      ctx.save();
      if (!isDirect) ctx.globalAlpha = 0.12;

      ctx.beginPath();
      ctx.arc(X(n.x), Y(n.y), rad + (isH ? 3 : 0), 0, 2 * Math.PI);
      ctx.fillStyle = isS ? '#0ea5e9' : (n.type === 'class' ? '#a855f7' : n.type === 'component' ? '#10b981' : '#38bdf8');
      ctx.fill();

      if (isS || isH) {
        ctx.shadowColor = '#38bdf8';
        ctx.shadowBlur = 14;
      }
      ctx.lineWidth = (isS ? 3.5 : isH ? 2.5 : 1.2) * dpr;
      ctx.strokeStyle = isS ? '#fff' : (dark ? 'rgba(255,255,255,0.8)' : '#0f172a');
      ctx.stroke();

      if (isS || isH || (isDirect && s > 0.55)) {
        ctx.fillStyle = isS ? '#38bdf8' : (dark ? '#f8fafc' : '#0f172a');
        ctx.font = (10.5 * dpr) + 'px ui-monospace, monospace';
        ctx.textAlign = 'left';
        ctx.fillText(n.name.slice(0, 30), X(n.x) + rad + 6 * dpr, Y(n.y) + 4 * dpr);
      }
      ctx.restore();
    });
  }

  drawMinimap();
}

function pick(mx, my){
  var s = cam.scale * dpr;
  var wx = (mx * dpr + cam.x * s) / s, wy = (my * dpr + cam.y * s) / s;
  var best = null, bd = 1e12;
  currentPoints().forEach(function(n){
    var rad = (n.r || 8) + 12 / s;
    var dx = n.x - wx, dy = n.y - wy, d = Math.sqrt(dx * dx + dy * dy);
    if (d < rad && d < bd) { bd = d; best = n; }
  });
  if (!best) return null;
  if (mode === 'cluster') return { kind: 'cluster', key: best.key };
  if (mode === 'file') return { kind: 'file', id: best.id };
  return { kind: 'symbol', id: best.id };
}

function updateSidePanel(p){
  var sideTitle = document.getElementById('side-title');
  var sideSub = document.getElementById('side-sub');
  var sideBody = document.getElementById('side-body');

  if (!p) {
    sideTitle.textContent = 'ScopeCairn Inspector';
    sideSub.textContent = 'Click node to inspect dependencies';
    sideBody.innerHTML = '<div class="metric-card" style="text-align:center;padding:24px 10px;"><div style="font-size:24px;margin-bottom:8px;">🎯</div><div style="font-size:13px;font-weight:600;margin-bottom:4px;">No Selection</div><div style="font-size:11.5px;color:var(--mut);">Click on any node to isolate its connections, view centrality scores, and inspect callers & callees.</div></div>';
    bannerFocus.style.display = 'none';
    return;
  }

  side.classList.remove('collapsed');

  function chip(text, rel, onclickCode) {
    return '<div class="node-chip" onclick="' + onclickCode + '"><span>' + text + '</span><span class="rel-tag">' + (rel || 'LINK') + '</span></div>';
  }

  if (p.kind === 'cluster') {
    var c = clusters.filter(function(x){ return x.key === p.key; })[0];
    if (!c) return;
    sideTitle.textContent = c.name;
    sideSub.textContent = 'Community Cluster · ' + c.members.length + ' files';
    focusText.textContent = '🎯 Community: ' + c.name + ' (' + c.members.length + ' files)';
    bannerFocus.style.display = 'inline-flex';

    var html = '<div class="section-title">Member Files (' + c.members.length + ')</div><div class="chip-list">';
    html += c.members.slice(0, 30).map(function(n){
      return chip(n.file, n.lang, 'window.__selectNode("file",' + n.id + ')');
    }).join('');
    if (c.members.length > 30) html += '<div style="font-size:11.5px;color:var(--mut);text-align:center;">+' + (c.members.length - 30) + ' more files</div>';
    html += '</div>';
    sideBody.innerHTML = html;
  } else if (p.kind === 'file') {
    var n = byFileId[p.id];
    if (!n) return;
    sideTitle.textContent = n.file.split('/').pop() || n.file;
    sideSub.textContent = n.file;
    focusText.textContent = '🎯 Focused file: ' + n.file;
    bannerFocus.style.display = 'inline-flex';

    var nbrs = fedges.filter(function(e){ return e.a === n.id || e.b === n.id; });
    var html = '<div class="metrics-grid">' +
      '<div class="metric-card"><div class="val">' + n.symbols + '</div><div class="lbl">Symbols</div></div>' +
      '<div class="metric-card"><div class="val">' + (n.pr ? (n.pr * 100).toFixed(2) + '%' : '—') + '</div><div class="lbl">PageRank</div></div>' +
      '<div class="metric-card"><div class="val">' + n.inn + '</div><div class="lbl">Fan-In</div></div>' +
      '<div class="metric-card"><div class="val">' + n.out + '</div><div class="lbl">Fan-Out</div></div>' +
      '</div>';

    html += '<div class="section-title">Connected Files (' + nbrs.length + ')</div><div class="chip-list">';
    html += nbrs.slice(0, 20).map(function(e){
      var o = (e.a === n.id) ? byFileId[e.b] : byFileId[e.a];
      var name = o ? o.file : ('file#' + (e.a === n.id ? e.b : e.a));
      var dir = (e.a === n.id) ? '→ ' + e.rel : '← ' + e.rel;
      return chip(name, dir, 'window.__selectNode("file",' + (o ? o.id : e.b) + ')');
    }).join('') || '<div style="color:var(--mut);font-size:12px;">No connections</div>';
    html += '</div>';
    sideBody.innerHTML = html;
  } else {
    var x = bySymId[p.id];
    if (!x) return;
    sideTitle.textContent = x.name;
    sideSub.textContent = x.type + ' · ' + x.file;
    focusText.textContent = '🎯 Focused symbol: ' + x.name + ' (' + x.type + ')';
    bannerFocus.style.display = 'inline-flex';

    var html = '<div class="metrics-grid">' +
      '<div class="metric-card"><div class="val">' + (x.pr ? (x.pr * 100).toFixed(2) + '%' : '—') + '</div><div class="lbl">PageRank</div></div>' +
      '<div class="metric-card"><div class="val">' + x.inn + ' / ' + x.out + '</div><div class="lbl">In / Out</div></div>' +
      '</div>';

    html += '<div class="section-title">Callers / Importers (' + x.callers.length + ')</div><div class="chip-list">';
    html += x.callers.slice(0, 15).map(function(c){
      return '<div class="node-chip"><span>' + c + '</span><span class="rel-tag">IN</span></div>';
    }).join('') || '<div style="color:var(--mut);font-size:12px;">None</div>';
    html += '</div>';

    html += '<div class="section-title">Calls / Depends On (' + x.callees.length + ')</div><div class="chip-list">';
    html += x.callees.slice(0, 15).map(function(c){
      return '<div class="node-chip"><span>' + c + '</span><span class="rel-tag">OUT</span></div>';
    }).join('') || '<div style="color:var(--mut);font-size:12px;">None</div>';
    html += '</div>';
    sideBody.innerHTML = html;
  }
}

window.__selectNode = function(kind, id) {
  if (kind === 'file') {
    mode = 'file';
    document.querySelectorAll('.seg button').forEach(function(b){ b.classList.toggle('on', b.dataset.mode === 'file'); });
    var n = byFileId[id];
    if (n) { sel = { kind: 'file', id: id }; updateSidePanel(sel); centerOn(n.x, n.y, 1.8); }
  } else if (kind === 'symbol') {
    mode = 'symbol';
    document.querySelectorAll('.seg button').forEach(function(b){ b.classList.toggle('on', b.dataset.mode === 'symbol'); });
    var s = bySymId[id];
    if (s) { sel = { kind: 'symbol', id: id }; updateSidePanel(sel); centerOn(s.x, s.y, 2.2); }
  }
};

wrap.addEventListener('mousedown', function(e){
  drag = { x: e.clientX - cam.x * cam.scale, y: e.clientY - cam.y * cam.scale };
  wrap.style.cursor = 'grabbing';
});
window.addEventListener('mouseup', function(){
  drag = null;
  wrap.style.cursor = 'grab';
});
window.addEventListener('mousemove', function(e){
  var r = wrap.getBoundingClientRect();
  if (drag) {
    cam.x = (e.clientX - drag.x) / cam.scale;
    cam.y = (e.clientY - drag.y) / cam.scale;
    draw();
    tip.style.display = 'none';
    return;
  }
  if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) {
    tip.style.display = 'none';
    hover = null;
    return;
  }
  var p = pick(e.clientX - r.left, e.clientY - r.top);
  hover = p;
  if (p) {
    var t = p.kind === 'cluster'
      ? ('🏢 Community: ' + p.key)
      : (p.kind === 'file'
        ? ('📄 ' + byFileId[p.id].file + '\\n' + byFileId[p.id].symbols + ' symbols · in ' + byFileId[p.id].inn + ' / out ' + byFileId[p.id].out)
        : ('⚡ ' + bySymId[p.id].name + ' (' + bySymId[p.id].type + ')\\n' + bySymId[p.id].file));
    tip.textContent = t;
    tip.style.display = 'block';
    tip.style.left = (e.clientX + 14) + 'px';
    tip.style.top = (e.clientY + 14) + 'px';
    cv.style.cursor = 'pointer';
  } else {
    tip.style.display = 'none';
    cv.style.cursor = 'default';
  }
  draw();
});

wrap.addEventListener('click', function(e){
  if (drag && Math.abs(e.clientX - drag.x) > 4) return;
  var r = wrap.getBoundingClientRect();
  var p = pick(e.clientX - r.left, e.clientY - r.top);
  sel = p;
  updateSidePanel(p);
  draw();
});

wrap.addEventListener('dblclick', function(e){
  var r = wrap.getBoundingClientRect();
  var p = pick(e.clientX - r.left, e.clientY - r.top);
  if (p) {
    var target = (p.kind === 'cluster') ? clusters.find(function(c){ return c.key === p.key; }) : (p.kind === 'file' ? byFileId[p.id] : bySymId[p.id]);
    if (target) centerOn(target.x, target.y, cam.scale * 1.6);
  }
});

wrap.addEventListener('wheel', function(e){
  e.preventDefault();
  var r = wrap.getBoundingClientRect();
  var mx = e.clientX - r.left;
  var my = e.clientY - r.top;
  var factor = e.deltaY < 0 ? 1.15 : 0.87;
  zoomAt(mx, my, factor);
}, { passive: false });

document.getElementById('btn-clear-focus').addEventListener('click', function(){
  sel = null;
  updateSidePanel(null);
  draw();
});

// Mode buttons
document.querySelectorAll('.seg button').forEach(function(b){
  b.addEventListener('click', function(){
    document.querySelectorAll('.seg button').forEach(function(x){ x.classList.remove('on'); });
    b.classList.add('on');
    mode = b.dataset.mode;
    sel = null;
    updateSidePanel(null);
    fit();
  });
});

// Search & filters
var q = document.getElementById('q');
q.addEventListener('input', function(){ query = q.value.toLowerCase(); draw(); });
var tf = document.getElementById('tf');
tf.addEventListener('change', function(){
  typeF = tf.value;
  if (mode !== 'symbol' && typeF) {
    mode = 'symbol';
    document.querySelectorAll('.seg button').forEach(function(x){ x.classList.toggle('on', x.dataset.mode === mode); });
  }
  draw();
});
var ef = document.getElementById('ef');
ef.addEventListener('change', function(){ relF = ef.value; draw(); });

// HUD actions
document.getElementById('fit').addEventListener('click', fit);
document.getElementById('hud-fit').addEventListener('click', fit);
document.getElementById('hud-zoom-in').addEventListener('click', function(){
  var r = wrap.getBoundingClientRect();
  zoomAt(r.width / 2, r.height / 2, 1.3);
});
document.getElementById('hud-zoom-out').addEventListener('click', function(){
  var r = wrap.getBoundingClientRect();
  zoomAt(r.width / 2, r.height / 2, 0.77);
});

// Minimap toggle & click-to-pan
var minimapPanel = document.getElementById('minimap-panel');
document.getElementById('hud-map-toggle').addEventListener('click', function(){
  minimapPanel.classList.toggle('hidden');
});
miniCv.addEventListener('click', function(e){
  var r = miniCv.getBoundingClientRect();
  var mx = e.clientX - r.left, my = e.clientY - r.top;
  var pts = currentPoints();
  if (!pts.length) return;
  var xs = pts.map(function(p){ return p.x; }), ys = pts.map(function(p){ return p.y; });
  var x0 = Math.min.apply(0, xs) - 40, x1 = Math.max.apply(0, xs) + 40;
  var y0 = Math.min.apply(0, ys) - 40, y1 = Math.max.apply(0, ys) + 40;
  var gw = Math.max(10, x1 - x0), gh = Math.max(10, y1 - y0);
  var s = Math.min(miniCv.width / gw, miniCv.height / gh) * 0.9;
  var ox = (miniCv.width - gw * s) / 2, oy = (miniCv.height - gh * s) / 2;
  var wx = ((mx * dpr - ox) / s) + x0;
  var wy = ((my * dpr - oy) / s) + y0;
  centerOn(wx, wy);
});

// Theme toggle
document.getElementById('btn-theme').addEventListener('click', function(){
  darkTheme = !darkTheme;
  document.documentElement.setAttribute('data-theme', darkTheme ? 'dark' : 'light');
  this.textContent = darkTheme ? '🌙 Theme' : '☀️ Theme';
  draw();
});

// Side drawer toggle
document.getElementById('btn-side-toggle').addEventListener('click', function(){
  side.classList.toggle('collapsed');
});
document.getElementById('side-close-btn').addEventListener('click', function(){
  side.classList.add('collapsed');
});

// Shortcuts modal
var modal = document.getElementById('modal-shortcuts');
document.getElementById('btn-shortcuts').addEventListener('click', function(){ modal.style.display = 'flex'; });
document.getElementById('modal-close-btn').addEventListener('click', function(){ modal.style.display = 'none'; });
window.addEventListener('click', function(e){ if (e.target === modal) modal.style.display = 'none'; });

// Keyboard shortcuts
window.addEventListener('keydown', function(e){
  if (e.key === '/' && document.activeElement !== q) {
    e.preventDefault();
    q.focus();
  } else if (e.key === 'Escape') {
    if (modal.style.display === 'flex') modal.style.display = 'none';
    else if (sel) { sel = null; updateSidePanel(null); draw(); }
    else if (q.value) { q.value = ''; query = ''; draw(); }
  } else if (e.key === '1' && document.activeElement !== q) {
    mode = 'cluster';
    document.querySelectorAll('.seg button').forEach(function(b){ b.classList.toggle('on', b.dataset.mode === 'cluster'); });
    fit();
  } else if (e.key === '2' && document.activeElement !== q) {
    mode = 'file';
    document.querySelectorAll('.seg button').forEach(function(b){ b.classList.toggle('on', b.dataset.mode === 'file'); });
    fit();
  } else if (e.key === '3' && document.activeElement !== q) {
    mode = 'symbol';
    document.querySelectorAll('.seg button').forEach(function(b){ b.classList.toggle('on', b.dataset.mode === 'symbol'); });
    fit();
  } else if ((e.key === 'f' || e.key === 'F') && document.activeElement !== q) {
    fit();
  }
});

resize();
fit();
})();
</script>
</body>
</html>`;
}

function r1(v: number): string {
  return (Math.round(v * 10) / 10).toString();
}

// Convex hull (Andrew monotone chain) per modul, digelembungkan radius node.
function hulls(nodes: VNode[]): { d: string; color: string }[] {
  const byMod = new Map<string, VNode[]>();
  for (const n of nodes) {
    const key = n.cluster >= 0 ? `c${n.cluster}` : n.module;
    if (!byMod.has(key)) byMod.set(key, []);
    byMod.get(key)!.push(n);
  }
  const out: { d: string; color: string }[] = [];
  for (const [mod, ns] of byMod) {
    if (ns.length < 3) continue;
    const pts = ns
      .map((n) => ({ x: n.x, y: n.y }))
      .sort((a, b) => (a.x === b.x ? a.y - b.y : a.x - b.x));
    const cross = (
      o: { x: number; y: number },
      a: { x: number; y: number },
      b: { x: number; y: number }
    ): number => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
    const lower: { x: number; y: number }[] = [];
    const upper: { x: number; y: number }[] = [];
    for (const p of pts) {
      while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) {
        lower.pop();
      }
      lower.push(p);
    }
    for (let i = pts.length - 1; i >= 0; i--) {
      const p = pts[i];
      while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) {
        upper.pop();
      }
      upper.push(p);
    }
    lower.pop();
    upper.pop();
    const hull = lower.concat(upper);
    if (hull.length < 3) continue;
    // Pad manual: geser tiap titik menjauhi centroid.
    const cx = hull.reduce((a, p) => a + p.x, 0) / hull.length;
    const cy = hull.reduce((a, p) => a + p.y, 0) / hull.length;
    const d =
      hull
        .map((p, i) => {
          const dx = p.x - cx;
          const dy = p.y - cy;
          const l = Math.max(1, Math.sqrt(dx * dx + dy * dy));
          const x = p.x + (dx / l) * 26;
          const y = p.y + (dy / l) * 26;
          return `${i === 0 ? "M" : "L"}${r1(x)},${r1(y)}`;
        })
        .join(" ") + " Z";
    out.push({ d, color: colorFor(mod) });
  }
  return out;
}

function shortName(file: string): string {
  const parts = file.split("/");
  if (parts.length <= 2) return file;
  return parts[0] + "/…/" + parts[parts.length - 1];
}

export { shortName as _shortName, hulls as _hulls };
