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
    .replace(/"/g, "&quot;");
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
      ? ` · ${model.clusterNames.length} communities (Louvain Q=${model.modularity.toFixed(3)})`
      : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} — ScopeCairn graph explorer</title>
<style>
:root{--bg:#fafafa;--panel:#fff;--line:#ddd;--ink:#222;--mut:#666;--acc:#0969da}
*{box-sizing:border-box}
body{font-family:system-ui,-apple-system,sans-serif;margin:0;background:var(--bg);color:var(--ink)}
header{padding:10px 14px;background:var(--panel);border-bottom:1px solid var(--line);position:sticky;top:0;z-index:3}
header h1{font-size:15px;margin:0 0 2px}
header p{font-size:12px;color:var(--mut);margin:2px 0}
#bar{display:flex;gap:8px;align-items:center;margin-top:8px;flex-wrap:wrap}
#bar input,#bar select{padding:5px 8px;font-size:13px;border:1px solid var(--line);border-radius:6px}
#q{flex:1;min-width:160px;max-width:320px}
.seg{display:flex;border:1px solid var(--line);border-radius:6px;overflow:hidden}
.seg button{border:0;background:#f3f4f6;padding:5px 10px;font-size:12.5px;cursor:pointer}
.seg button.on{background:#1f2328;color:#fff}
#main{display:flex;height:calc(100vh - 158px);min-height:420px}
#wrap{flex:1;position:relative;overflow:hidden;cursor:grab;background:#fff}
#cv{position:absolute;inset:0;width:100%;height:100%}
#side{width:320px;max-width:38vw;overflow:auto;background:var(--panel);border-left:1px solid var(--line);padding:12px 14px;font-size:13px}
#side h2{font-size:14px;margin:0 0 4px;word-break:break-all}
#side .meta{color:var(--mut);font-size:12px;margin:0 0 8px}
#side h3{font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:var(--mut);margin:12px 0 4px}
#side ul{margin:0;padding-left:18px}
#side code{background:#f3f4f6;border-radius:4px;padding:0 4px}
#tip{position:fixed;display:none;background:#111;color:#eee;font:12px ui-monospace,monospace;padding:6px 9px;border-radius:6px;pointer-events:none;white-space:pre;z-index:5;max-width:60vw}
.hint{font-size:12px;color:var(--mut);padding:6px 14px}
kbd{background:#f3f4f6;border:1px solid var(--line);border-radius:4px;padding:0 5px;font-size:11px}
</style>
</head>
<body>
<header>
<h1>${esc(title)} — ${model.nodes.length} files, ${model.symbols.length} symbols, ${model.edges.length} links${esc(truncNote)}</h1>
<p>Generated by <code>scopecairn scan</code> · ${esc(generated)} · interactive Canvas explorer (offline, zero dependencies)${esc(clusterNote)}</p>
<div id="bar">
<div class="seg" role="tablist" aria-label="hierarchy">
<button data-mode="cluster" class="on">Cluster</button><button data-mode="file">File</button><button data-mode="symbol">Symbol</button>
</div>
<input id="q" placeholder="live search: name, type, module…" autocomplete="off">
<select id="tf"><option value="">all types</option><option>function</option><option>class</option><option>method</option><option>route</option><option>model</option><option>component</option><option>interface</option><option>type</option></select>
<button id="fit">fit</button>
<span style="font-size:12px;color:var(--mut)">drag pan · wheel zoom · hover inspect · click details</span>
</div>
</header>
<div class="hint" id="count"></div>
<div id="main">
<div id="wrap"><canvas id="cv"></canvas></div>
<aside id="side"><h2>Graph explorer</h2><p class="meta">Klik node untuk melihat sumber singkat, pengimpor / yang dipanggil, dan skor centrality.</p><p class="meta">Toggle <kbd>Cluster</kbd>↔<kbd>File</kbd>↔<kbd>Symbol</kbd> untuk ganti hierarki tampilan.</p></aside>
</div>
<div id="tip"></div>
<script>
(function(){
"use strict";
var DATA=${payload};
var files=DATA.files, fedges=DATA.edges, syms=DATA.symbols, sedges=DATA.symbolEdges;
var byFileId={}, bySymId={};
files.forEach(function(n){byFileId[n.id]=n;});
syms.forEach(function(s){bySymId[s.id]=s;});
// Cluster view: agregat file per komunitas Louvain (fallback modul folder).
var clusters=[];
(function(){
  var m={};
  files.forEach(function(n){
    var key=n.cluster>=0?("c"+n.cluster):("m:"+n.module);
    if(!m[key])m[key]={key:key,cluster:n.cluster,name:n.cluster>=0?n.clusterName:n.module,members:[],x:0,y:0,r:0};
    m[key].members.push(n);
  });
  Object.keys(m).forEach(function(k){
    var c=m[k],sx=0,sy=0;
    c.members.forEach(function(n){sx+=n.x;sy+=n.y;});
    c.x=sx/c.members.length;c.y=sy/c.members.length;
    c.r=Math.min(46,14+Math.sqrt(c.members.length)*6);
    clusters.push(c);
  });
})();
var cv=document.getElementById('cv'),ctx=cv.getContext('2d'),wrap=document.getElementById('wrap');
var side=document.getElementById('side'),tip=document.getElementById('tip'),count=document.getElementById('count');
var mode='cluster',query='',typeF='';
var cam={x:0,y:0,scale:1},drag=null,hover=null,sel=null,dpr=1;
function resize(){
  dpr=Math.min(2,window.devicePixelRatio||1);
  var r=wrap.getBoundingClientRect();
  cv.width=Math.max(1,r.width*dpr);cv.height=Math.max(1,r.height*dpr);
  draw();
}
window.addEventListener('resize',resize);
function w2s(p){return [(p[0]-cam.x)*cam.scale*dpr,(p[1]-cam.y)*cam.scale*dpr];}
function fit(){
  var pts=currentPoints();
  if(!pts.length){cam={x:0,y:0,scale:1};draw();return;}
  var xs=pts.map(function(p){return p.x;}),ys=pts.map(function(p){return p.y;});
  var x0=Math.min.apply(0,xs)-60,x1=Math.max.apply(0,xs)+60;
  var y0=Math.min.apply(0,ys)-60,y1=Math.max.apply(0,ys)+60;
  var r=wrap.getBoundingClientRect();
  var s=Math.min(r.width/(x1-x0),r.height/(y1-y0));
  s=Math.min(3,Math.max(.05,s));
  cam.scale=s;cam.x=x0-(r.width/s-(x1-x0))/2;cam.y=y0-(r.height/s-(y1-y0))/2;
  draw();
}
function match(n){
  if(typeF && (n.type||'')!==typeF)return false;
  if(!query)return true;
  var hay=((n.name||n.file||'')+' '+(n.type||'')+' '+(n.module||'')+' '+(n.clusterName||'')).toLowerCase();
  return hay.indexOf(query)>=0;
}
function currentPoints(){
  if(mode==='symbol')return syms.filter(match);
  if(mode==='file')return files.filter(match);
  return clusters;
}
function draw(){
  var r=wrap.getBoundingClientRect(),W=r.width*dpr,H=r.height*dpr;
  ctx.clearRect(0,0,W,H);
  ctx.fillStyle='#fff';ctx.fillRect(0,0,W,H);
  var s=cam.scale*dpr,ox=-cam.x*s,oy=-cam.y*s;
  function X(x){return x*s+ox;} function Y(y){return y*s+oy;}
  ctx.lineWidth=1;
  if(mode==='cluster'){
    clusters.forEach(function(c){
      ctx.beginPath();ctx.arc(X(c.x),Y(c.y),c.r*s,0,7);
      ctx.fillStyle='rgba(9,105,218,.10)';ctx.fill();
      ctx.fillStyle='#1f2328';ctx.font=(12*dpr)+'px system-ui';
      ctx.textAlign='center';
      ctx.fillText(c.name+' ('+c.members.length+')',X(c.x),Y(c.y)-c.r*s-6*dpr);
    });
    clusters.forEach(function(c){
      var sel2=(sel&&sel.kind==='cluster'&&sel.key===c.key);
      ctx.beginPath();ctx.arc(X(c.x),Y(c.y),Math.max(3,c.r*s),0,7);
      ctx.fillStyle=sel2?'#0969da':'#57606a';ctx.fill();
      if(sel2){ctx.strokeStyle='#0969da';ctx.lineWidth=3*dpr;ctx.stroke();}
    });
  }else if(mode==='file'){
    fedges.forEach(function(e){
      var a=byFileId[e.a],b=byFileId[e.b];
      if(!a||!b||!match(a)||!match(b))return;
      ctx.beginPath();ctx.moveTo(X(a.x),Y(a.y));ctx.lineTo(X(b.x),Y(b.y));
      ctx.strokeStyle=e.conf<0.8?'rgba(150,150,150,.45)':'rgba(120,120,120,.55)';
      ctx.setLineDash(e.conf<0.8?[5,4]:[]);
      ctx.lineWidth=Math.min(3,(0.5+e.n*0.4))*dpr*0.6;ctx.stroke();ctx.setLineDash([]);
    });
    var ranked=files.slice().sort(function(a,b){return (b.inn+b.out)-(a.inn+a.out);});
    var labeled={};ranked.slice(0,25).forEach(function(n){labeled[n.id]=1;});
    files.forEach(function(n){
      if(!match(n))return;
      var rad=Math.max(2.5,n.r*s),isH=hover&&hover.kind==='file'&&hover.id===n.id;
      var isS=sel&&sel.kind==='file'&&sel.id===n.id;
      ctx.beginPath();ctx.arc(X(n.x),Y(n.y),rad+(isH?2:0),0,7);
      ctx.fillStyle=n.color||'#57606a';ctx.fill();
      ctx.lineWidth=(isS?3:1.2)*dpr;ctx.strokeStyle=isS?'#0969da':'#1f2328';ctx.stroke();
      if(labeled[n.id]&&s>0.35){
        ctx.fillStyle='#24292f';ctx.font=(10.5*dpr)+'px ui-monospace,monospace';ctx.textAlign='left';
        var nm=n.file.split('/');var sh=nm.length>2?(nm[0]+'/…/'+nm[nm.length-1]):n.file;
        ctx.fillText(sh,X(n.x)+rad+4*dpr,Y(n.y)+4*dpr);
      }
    });
  }else{
    var se={};
    sedges.forEach(function(e){
      var a=bySymId[e.s],b=bySymId[e.t];
      if(!a||!b||!match(a)||!match(b))return;
      var k=e.s+':'+e.t;if(se[k])return;se[k]=1;
      ctx.beginPath();ctx.moveTo(X(a.x),Y(a.y));ctx.lineTo(X(b.x),Y(b.y));
      ctx.strokeStyle='rgba(120,120,120,.4)';ctx.lineWidth=1*dpr;ctx.stroke();
    });
    var top=syms.slice().sort(function(a,b){return b.pr-a.pr;});
    var lab={};top.slice(0,30).forEach(function(x){lab[x.id]=1;});
    syms.forEach(function(n){
      if(!match(n))return;
      var base=4+Math.min(9,Math.sqrt(n.inn+n.out)*2+(n.pr*400));
      var rad=Math.max(2.5,base*s),isH=hover&&hover.kind==='symbol'&&hover.id===n.id;
      var isS=sel&&sel.kind==='symbol'&&sel.id===n.id;
      ctx.beginPath();ctx.arc(X(n.x),Y(n.y),rad+(isH?2:0),0,7);
      ctx.fillStyle=isS?'#0969da':'#8250df';ctx.fill();
      ctx.lineWidth=1.2*dpr;ctx.strokeStyle='#1f2328';ctx.stroke();
      if(lab[n.id]&&s>0.5){
        ctx.fillStyle='#24292f';ctx.font=(10*dpr)+'px ui-monospace,monospace';ctx.textAlign='left';
        ctx.fillText(n.name.slice(0,32),X(n.x)+rad+4*dpr,Y(n.y)+4*dpr);
      }
    });
  }
  var pts=currentPoints();
  count.textContent='showing '+pts.length+' / '+(mode==='symbol'?syms.length:mode==='file'?files.length:clusters.length)+' · '+mode+' view · scroll zoom · drag pan';
}
function pick(mx,my){
  var r=wrap.getBoundingClientRect(),s=cam.scale*dpr;
  var wx=(mx*dpr+cam.x*s)/s,wy=(my*dpr+cam.y*s)/s;
  var best=null,bd=1e12;
  currentPoints().forEach(function(n){
    var rad=(n.r||8)+8/s;
    var dx=n.x-wx,dy=n.y-wy,d=Math.sqrt(dx*dx+dy*dy);
    if(d<rad&&d<bd){bd=d;best=n;}
  });
  if(!best)return null;
  if(mode==='cluster')return {kind:'cluster',key:best.key};
  if(mode==='file')return {kind:'file',id:best.id};
  return {kind:'symbol',id:best.id};
}
function detailHTML(p){
  function li(a){return '<li><code>'+a.replace(/&/g,'&amp;').replace(/</g,'&lt;')+'</code></li>';}
  if(p.kind==='cluster'){
    var c=clusters.filter(function(x){return x.key===p.key;})[0];
    if(!c)return '';
    return '<h2>'+c.name+'</h2><p class="meta">community · '+c.members.length+' files</p><h3>Members</h3><ul>'+
      c.members.slice(0,20).map(function(n){return li(n.file);}).join('')+'</ul>'+
      (c.members.length>20?'<p class="meta">+'+(c.members.length-20)+' more</p>':'');
  }
  if(p.kind==='file'){
    var n=byFileId[p.id];if(!n)return '';
    var nbrs=fedges.filter(function(e){return e.a===n.id||e.b===n.id;}).slice(0,12);
    return '<h2>'+n.file+'</h2><p class="meta">'+n.lang+' · '+n.symbols+' symbols · in '+n.inn+' / out '+n.out+
      (n.cluster>=0?' · '+n.clusterName:'')+(n.pr?' · pr='+n.pr.toFixed(4):'')+'</p><h3>Links</h3><ul>'+
      nbrs.map(function(e){var o=e.a===n.id?byFileId[e.b]:byFileId[e.a];return li((o?o.file:e.a===n.id?e.b:e.a)+' ('+e.rel+' ×'+e.n+')');}).join('')+'</ul>';
  }
  var x=bySymId[p.id];if(!x)return '';
  return '<h2>'+x.name+'</h2><p class="meta">'+x.type+' · '+x.file+(x.cluster>=0?' · cluster '+x.cluster:'')+
    ' · pr='+(x.pr||0).toFixed(4)+' · in '+x.inn+' / out '+x.out+'</p>'+
    '<h3>Callers / importers</h3><ul>'+(x.callers.slice(0,8).map(li).join('')||'<li>—</li>')+'</ul>'+
    '<h3>Calls / depends on</h3><ul>'+(x.callees.slice(0,8).map(li).join('')||'<li>—</li>')+'</ul>';
}
wrap.addEventListener('mousedown',function(e){drag={x:e.clientX-cam.x*cam.scale,y:e.clientY-cam.y*cam.scale};wrap.style.cursor='grabbing';});
window.addEventListener('mouseup',function(){drag=null;wrap.style.cursor='grab';});
window.addEventListener('mousemove',function(e){
  var r=wrap.getBoundingClientRect();
  if(drag){
    cam.x=(e.clientX-drag.x)/cam.scale;cam.y=(e.clientY-drag.y)/cam.scale;draw();tip.style.display='none';return;
  }
  if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom){tip.style.display='none';hover=null;return;}
  var p=pick(e.clientX-r.left,e.clientY-r.top);
  hover=p;
  if(p){
    var t=p.kind==='cluster'?p.key:(p.kind==='file'?byFileId[p.id].file:bySymId[p.id].name+' ('+bySymId[p.id].type+', '+bySymId[p.id].file+')');
    tip.textContent=t;tip.style.display='block';tip.style.left=(e.clientX+12)+'px';tip.style.top=(e.clientY+12)+'px';
    cv.style.cursor='pointer';
  }else{tip.style.display='none';cv.style.cursor='default';}
  draw();
});
wrap.addEventListener('click',function(e){
  if(drag&&Math.abs(e.clientX-drag.x)>4)return;
  var r=wrap.getBoundingClientRect();
  var p=pick(e.clientX-r.left,e.clientY-r.top);
  sel=p;draw();
  if(p)side.innerHTML=detailHTML(p);
});
wrap.addEventListener('wheel',function(e){
  e.preventDefault();
  var f=e.deltaY<0?1.12:0.89;
  cam.scale=Math.min(8,Math.max(.05,cam.scale*f));draw();
},{passive:false});
document.querySelectorAll('.seg button').forEach(function(b){
  b.addEventListener('click',function(){
    document.querySelectorAll('.seg button').forEach(function(x){x.classList.remove('on');});
    b.classList.add('on');mode=b.dataset.mode;sel=null;fit();
  });
});
var q=document.getElementById('q');
q.addEventListener('input',function(){query=q.value.toLowerCase();draw();});
var tf=document.getElementById('tf');
tf.addEventListener('change',function(){typeF=tf.value;if(mode!=='symbol'&&typeF)mode='symbol';
  document.querySelectorAll('.seg button').forEach(function(x){x.classList.toggle('on',x.dataset.mode===mode);});
  draw();});
document.getElementById('fit').addEventListener('click',fit);
resize();fit();
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
