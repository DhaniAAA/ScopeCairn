import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { openDb, dbPath, dataDir } from "../db.js";
import { logInvocation } from "../invocations.js";
import { refreshIndex } from "../refresh.js";
import { skipRefresh } from "./opts.js";
import { findSymbols, neighbors } from "../graph.js";
import { isProtected, loadProtectedPatterns } from "../scope/protected.js";
import {
  normalizeApiPath,
  parseRouteName,
  matchSegments,
  parseApiCalls,
  hasDynamicMarker,
} from "../adapters/apiCalls.js";
import { grammarForPath } from "../extract/treeSitter.js";

// Change Impact Analyzer (PRD FR-08).
// Input: path file ("src/x.ts"), atau nama simbol ("RequestService").
// Output: dampak langsung, tak langsung (2-hop), test, komponen UI.
// Cross-repo: `opts.repos` (daftar path / true = baca .scopecairn/repos.yml)
// menambah seksi blast radius lintas repo via kontrak CALLS_API ternormalisasi
// — tanpa command baru, tanpa migrasi skema, read-only ke repo lain.

import { cmdTestSelect } from "./testselect.js";

export async function cmdImpact(
  repoRoot: string,
  target: string,
  opts: { noRefresh?: boolean; refresh?: boolean; json?: boolean; repos?: string | boolean; runTests?: boolean; testsOnly?: boolean } = {}
): Promise<void> {
  if (opts.runTests || opts.testsOnly) {
    cmdTestSelect(repoRoot, target, { run: opts.runTests, json: opts.json });
    return;
  }

  if (!skipRefresh(opts)) await refreshIndex(repoRoot);

  const db = openDb(repoRoot);
  try {
    logInvocation(db, "impact");
    // Resolve target → himpunan node awal (satu file = semua simbolnya diringkas
    // ke file-symbol + simbol bernama bila cocok).
    let seeds = findSymbols(db, target);
    if (seeds.length === 0) {
      // Coba sebagai path: cocokkan akhiran (mis. `scanner.ts` → `src/scanner.ts`).
      const rows = db
        .prepare(
          `SELECT s.id, s.name, s.type, f.path AS file FROM symbols s
           JOIN files f ON f.id = s.file_id WHERE f.path LIKE ? ESCAPE '\\' LIMIT 20`
        )
        .all(`%${target.replace(/[\\%_]/g, (c) => "\\" + c)}`) as { id: number; name: string; type: string; file: string }[];
      seeds = rows;
    }
    if (seeds.length === 0) {
      console.log(`Tidak ada file/simbol yang cocok dengan "${target}".`);
      return;
    }

    // Bila target adalah file: pakai file-symbol sebagai pusat.
    const fileHit = seeds.find((s) => s.type === "file");
    const center = fileHit ?? seeds[0];
    const centerLabel =
      fileHit != null
        ? `${center.file}`
        : `${center.name} (${center.type}, ${center.file})`;

    const direct = neighbors(db, center.id);
    const directIds = new Set(direct.map((e) => e.other.id));

    // Indirect: tetangga dari tetangga (2-hop), kecuali center + direct.
    const indirect = new Map<number, { name: string; type: string; file: string; via: string; rel: string; evidence: string }>();
    for (const e of direct.slice(0, 20)) {
      for (const e2 of neighbors(db, e.other.id, 20)) {
        if (e2.other.id === center.id || directIds.has(e2.other.id)) continue;
        if (!indirect.has(e2.other.id)) {
          indirect.set(e2.other.id, {
            name: e2.other.name,
            type: e2.other.type,
            file: e2.other.file,
            via: e.other.name,
            rel: e2.rel,
            evidence: e2.evidence,
          });
        }
        if (indirect.size >= 15) break;
      }
      if (indirect.size >= 15) break;
    }

    const fmtFile = (f: string): string =>
      isProtected(f, loadProtectedPatterns(repoRoot)) ? `${f} ⚠ Protected` : f;

    const byRel = (rel: string, dir: "out" | "in"): string[] => {
      const seen = new Set<string>();
      const out: string[] = [];
      for (const e of direct) {
        if (e.rel !== rel || e.direction !== dir) continue;
        const label =
          e.other.type === "file" ? e.other.file : `${e.other.name} (${e.other.file})`;
        if (!seen.has(label)) {
          seen.add(label);
          out.push(label);
        }
        if (out.length >= 15) break;
      }
      // File-level: CALLS/QUERIES hidup di simbol — agregatkan dari simbol file ini.
      if (out.length === 0 && fileHit != null && (rel === "CALLS" || rel === "USES" || rel === "QUERIES" || rel === "CALLS_API")) {
        try {
          const rows = db
            .prepare(
              `SELECT DISTINCT t.name AS n, f.path AS p
               FROM relationships r
               JOIN symbols s ON s.id = ${dir === "out" ? "r.source_id" : "r.target_id"}
               JOIN symbols t ON t.id = ${dir === "out" ? "r.target_id" : "r.source_id"}
               JOIN files f ON f.id = t.file_id
               WHERE s.file_id = (SELECT file_id FROM symbols WHERE id = ?)
                 AND r.relationship_type = ? AND t.type != 'file'
               LIMIT 8`
            )
            .all(center.id, rel) as { n: string; p: string }[];
          for (const r of rows) {
            const label = `${r.n} (${r.p})`;
            if (!seen.has(label)) {
              seen.add(label);
              out.push(label);
            }
          }
        } catch {
          // ignore
        }
      }
      return out;
    };

    // Semua arah diringkas per level agar output hemat token.
    const directFiles = [...new Set(direct.map((e) => e.other.file))].filter(
      (f) => f !== center.file
    );
    const indirectVals = [...indirect.values()];
    const testFiles = [
      ...new Set([
        ...direct.filter((e) => e.rel === "TESTS").map((e) => e.other.file),
        ...indirectVals.filter((v) => v.rel === "TESTS").map((v) => v.file),
        ...directFiles.filter((f) => /(test|spec)/i.test(f)),
        ...indirectVals.map((v) => v.file).filter((f) => /(test|spec)/i.test(f)),
      ]),
    ].slice(0, 10);
    const ui = [
      ...new Set(
        [...direct.map((e) => e.other), ...indirectVals]
          .filter((n) => n.type === "component")
          .map((n) => `${n.name} (${n.file})`)
      ),
    ].slice(0, 10);

    // Static test reachability: lintasan CALLS balik dari simbol target →
    // simbol test yang masih memanggil salah satu seed (6 tingkat).
    const reachable = new Map<string, number>();
    try {
      const seeds = db
        .prepare(`SELECT id FROM symbols WHERE file_id = ? AND type != 'file'`)
        .all((db.prepare(`SELECT file_id AS f FROM symbols WHERE id = ?`).get(center.id) as { f: number }).f) as { id: number }[];
      const seen = new Set(seeds.map((s) => s.id));
      let frontier = seeds.map((s) => s.id);
      for (let d = 0; d < 6 && frontier.length > 0; d++) {
        const next: number[] = [];
        for (const id of frontier) {
          const rows = db
            .prepare(
              `SELECT s.id AS src, f.path AS fp FROM relationships r
               JOIN symbols s ON s.id = r.source_id
               JOIN files f ON f.id = s.file_id
               WHERE r.target_id = ? AND r.relationship_type = 'CALLS' LIMIT 100`
            )
            .all(id) as { src: number; fp: string }[];
          for (const r of rows) {
            if (seen.has(r.src)) continue;
            seen.add(r.src);
            next.push(r.src);
            if (/(test|spec)/i.test(r.fp)) {
              reachable.set(r.fp, Math.min(reachable.get(r.fp) ?? 99, d + 1));
            }
          }
        }
        frontier = next;
      }
    } catch {
      // tabel hubungan atau skema lama — abaikan
    }
    const reachableTests = [...reachable.entries()]
      .sort((a, b) => a[1] - b[1])
      .slice(0, 10);

    // Bukti file:line — symbols punya start_line, neighbors tidak membawanya.
    const lineOf = (id: number): number => {
      try {
        const r = db.prepare(`SELECT start_line AS l FROM symbols WHERE id = ?`).get(id) as { l: number } | undefined;
        return r?.l ?? 1;
      } catch {
        return 1;
      }
    };
    const withLine = (file: string, id: number): string => `${file}:${lineOf(id)}`;

    // Endpoint & model berkaitan: simbol type route/model di direct + indirect.
    const indirectEntries = [...indirect.entries()] as [number, { name: string; type: string; file: string }][];
    const endpoints = [
      ...new Set([
        ...direct.filter((e) => e.other.type === "route").map((e) => `${e.other.name} (${withLine(e.other.file, e.other.id)})`),
        ...indirectEntries.filter(([, v]) => v.type === "route").map(([id, v]) => `${v.name} (${withLine(v.file, id)})`),
      ]),
    ].slice(0, 10);
    const models = [
      ...new Set([
        ...direct.filter((e) => e.other.type === "model").map((e) => `${e.other.name} (${withLine(e.other.file, e.other.id)})`),
        ...indirectEntries.filter(([, v]) => v.type === "model").map(([id, v]) => `${v.name} (${withLine(v.file, id)})`),
      ]),
    ].slice(0, 10);

    // Klien terpengaruh (CALLS_API masuk): enclosing symbol pemanggil + komponen
    // UI 1 hop ke atas via CALLS/IMPORTS.
    const apiClients = direct.filter((e) => e.rel === "CALLS_API" && e.direction === "in");
    const apiClientLabels = [
      ...new Set(
        apiClients.map((e) =>
          e.other.type === "file" ? e.other.file : `${e.other.name} (${withLine(e.other.file, e.other.id)})`
        )
      ),
    ].slice(0, 10);
    if (apiClientLabels.length === 0 && fileHit != null) {
      try {
        const rows = db
          .prepare(
            `SELECT DISTINCT s.name AS n, f.path AS p, s.id AS sid
             FROM relationships r
             JOIN symbols s ON s.id = r.source_id
             JOIN files f ON f.id = s.file_id
             JOIN symbols t ON t.id = r.target_id
             WHERE t.file_id = (SELECT file_id FROM symbols WHERE id = ?)
               AND r.relationship_type = 'CALLS_API' AND s.type != 'file'
             LIMIT 8`
          )
          .all(center.id) as { n: string; p: string; sid: number }[];
        for (const r of rows) {
          const label = `${r.n} (${r.p}:${lineOf(r.sid)})`;
          if (!apiClientLabels.includes(label)) apiClientLabels.push(label);
        }
      } catch {
        // ignore
      }
    }
    const apiClientUi: string[] = [];
    try {
      const seenUi = new Set<string>();
      for (const c of apiClients.slice(0, 10)) {
        const up = neighbors(db, c.other.id, 20).filter(
          (e) => e.direction === "in" && (e.rel === "CALLS" || e.rel === "IMPORTS") && e.other.type === "component"
        );
        for (const u of up) {
          const label = `${u.other.name} (${u.other.file})`;
          if (!seenUi.has(label)) {
            seenUi.add(label);
            apiClientUi.push(label);
          }
          if (apiClientUi.length >= 10) break;
        }
        if (apiClientUi.length >= 10) break;
      }
    } catch {
      // ignore
    }

    // Tingkat risiko: protected / cycle / fan-in / sebaran file. Aditif, tanpa
    // mengubah seksi lama agar konsumen CLI lama tidak pecah.
    const reasons: string[] = [];
    let risk: "HIGH" | "MED" | "LOW" = "LOW";
    try {
      const centerFile = center.file;
      if (isProtected(centerFile, loadProtectedPatterns(repoRoot))) {
        risk = "HIGH";
        reasons.push(`target Protected (${centerFile})`);
      }
      const cycRows = db.prepare(`SELECT nodes_json AS js FROM cycles`).all() as { js: string }[];
      let inCycle = false;
      for (const c of cycRows) {
        try {
          const nodes = JSON.parse(c.js) as number[];
          if (nodes.includes(center.id)) { inCycle = true; break; }
        } catch { /* ignore */ }
      }
      if (inCycle) {
        risk = "HIGH";
        reasons.push(`di dalam dependency cycle`);
      }
      const fanIn = direct.filter((e) => e.rel === "CALLS" && e.direction === "in").length
        + direct.filter((e) => e.rel === "IMPORTS" && e.direction === "in").length;
      if (fanIn >= 10 || directFiles.length >= 10) {
        risk = "HIGH";
        reasons.push(`fan-in ${fanIn}, ${directFiles.length} file langsung`);
      } else if (fanIn >= 3 || testFiles.length >= 3 || reachableTests.length >= 3) {
        if (risk === "LOW") risk = "MED";
        reasons.push(`fan-in ${fanIn}, ${testFiles.length + reachableTests.length} test terkait`);
      }
      if (reasons.length === 0) reasons.push(`fan-in ${fanIn}, ${directFiles.length} file langsung`);
    } catch {
      reasons.push("risiko tak terhitung (skema lama)");
    }

    // Cross-repo blast radius (Opsi 1): konsumen HTTP di repo lain yang
    // memanggil route milik repo ini. Edge CALLS_API hanya tersimpan bila
    // route ada di DB yang sama (adapters/apiCalls.ts: deriveApiCalls),
    // sehingga untuk repo lain call site di-parse ulang lalu dicocokkan
    // via kontrak ternormalisasi (method + matchSegments). Read-only:
    // DB repo lain dibuka readOnly, tak pernah dibuat/di-scan.
    interface CrossRepoHit {
      repo: string;
      file: string;
      line: number;
      method: string;
      normalized: string;
      evidence: string;
    }
    const crossRepoHits: CrossRepoHit[] = [];
    const crossRepoNotes: string[] = [];
    const reposOpt = opts.repos;
    const wantCrossRepo =
      reposOpt === true ||
      (typeof reposOpt === "string" && reposOpt.trim().length > 0);
    if (wantCrossRepo) {
      // 1. Kumpulkan route provider milik repo ini dari center + tetangga.
      const providerRoutes: { method: string | null; normalized: string; rawPath: string }[] = [];
      const seenRoute = new Set<string>();
      const pushRoute = (name: string): void => {
        try {
          const parsed = parseRouteName(name);
          const normalized = normalizeApiPath(parsed.path);
          if (!normalized) return;
          const key = `${parsed.method ?? "*"} ${normalized}`;
          if (seenRoute.has(key)) return;
          seenRoute.add(key);
          providerRoutes.push({ method: parsed.method, normalized, rawPath: parsed.path });
        } catch {
          // abaikan nama route aneh
        }
      };
      if (center.type === "route") pushRoute(center.name);
      for (const e of direct) {
        if (e.other.type === "route") pushRoute(e.other.name);
        if (providerRoutes.length >= 10) break;
      }
      if (providerRoutes.length < 10) {
        try {
          const rows = db
            .prepare(`SELECT s.name AS n FROM symbols s JOIN files f ON f.id = s.file_id WHERE f.path = ? AND s.type = 'route' LIMIT 10`)
            .all(center.file) as { n: string }[];
          for (const r of rows) {
            pushRoute(r.n);
            if (providerRoutes.length >= 10) break;
          }
        } catch {
          // abaikan
        }
      }
      // 2. Resolve daftar repo: flag --repos atau .scopecairn/repos.yml.
      const MAX_REPOS = 5;
      let repoList: string[] = [];
      if (typeof reposOpt === "string" && reposOpt.trim().length > 0) {
        repoList = reposOpt.split(",").map((s) => s.trim()).filter(Boolean);
      } else {
        try {
          const yml = fs.readFileSync(path.join(dataDir(repoRoot), "repos.yml"), "utf8");
          const inline = yml.match(/repos\s*:\s*\[(.*?)\]/s)?.[1] ?? "";
          for (const m of inline.matchAll(/["']([^"']+)["']/g)) repoList.push(m[1]);
          for (const line of yml.split("\n")) {
            const t = line.trim();
            if (t.startsWith("- ")) {
              const v = t.slice(2).trim().replace(/^["']|["']$/g, "");
              if (v && !v.startsWith("#")) repoList.push(v);
            }
          }
        } catch {
          // tanpa repos.yml → beri tahu, bukan gagal
        }
      }
      repoList = [...new Set(repoList)].slice(0, MAX_REPOS);
      if (providerRoutes.length === 0) {
        crossRepoNotes.push("tidak ada route provider pada target — cross-repo dilewati");
      } else if (repoList.length === 0) {
        crossRepoNotes.push("daftar repo kosong (isi --repos a,b atau .scopecairn/repos.yml)");
      } else {
        const req = createRequire(import.meta.url);
        const staleRepos = new Set<string>();
        for (const rel of repoList) {
          if (crossRepoHits.length >= 50) break;
          let extRoot = "";
          try {
            extRoot = path.resolve(repoRoot, rel);
            if (extRoot === path.resolve(repoRoot)) continue;
            if (!fs.existsSync(extRoot) || !fs.statSync(extRoot).isDirectory()) {
              crossRepoNotes.push(`${rel}: direktori tidak ada — dilewati`);
              continue;
            }
            const extDbFile = dbPath(extRoot);
            if (!fs.existsSync(extDbFile)) {
              crossRepoNotes.push(`${rel}: belum di-index (tanpa scopecairn.db) — dilewati`);
              continue;
            }
            // Staleness: last_scan >7 hari atau tak terbaca → tandai, tetap lanjut.
            let stale = false;
            try {
              const RODB = req("node:" + "sqlite").DatabaseSync;
              const tmp = new RODB(extDbFile, { readOnly: true } as never);
              try {
                const row = tmp.prepare(`SELECT value AS v FROM meta WHERE key = 'last_scan'`).get() as { v: string } | undefined;
                if (!row?.v) stale = true;
                else if (Date.now() - Date.parse(row.v.replace(" ", "T") + "Z") > 7 * 864e5) stale = true;
              } finally {
                tmp.close();
              }
            } catch {
              stale = true;
            }
            // Kandidat file JS/TS dari index repo lain (tanpa re-scan).
            const RODB2 = req("node:" + "sqlite").DatabaseSync;
            const extDb = new RODB2(extDbFile, { readOnly: true } as never);
            let cand: string[] = [];
            try {
              const rows = extDb
                .prepare(`SELECT path AS p FROM files WHERE path LIKE '%.js' OR path LIKE '%.mjs' OR path LIKE '%.cjs' OR path LIKE '%.jsx' OR path LIKE '%.ts' OR path LIKE '%.tsx' LIMIT 200`)
                .all() as { p: string }[];
              cand = rows.map((r) => r.p);
            } finally {
              extDb.close();
            }
            const label = path.basename(extRoot) || rel;
            let perRepo = 0;
            for (const relPath of cand) {
              if (perRepo >= 10 || crossRepoHits.length >= 50) break;
              let grammar: string | null = null;
              try {
                grammar = grammarForPath(relPath);
              } catch {
                continue;
              }
              if (!grammar || !["typescript", "tsx", "javascript"].includes(grammar)) continue;
              let content = "";
              try {
                if (fs.statSync(path.join(extRoot, relPath)).size > 500_000) continue;
                content = fs.readFileSync(path.join(extRoot, relPath), "utf8");
              } catch {
                continue;
              }
              let calls: { method: string; raw: string; normalized: string; line: number }[] = [];
              try {
                calls = parseApiCalls(content, grammar);
              } catch {
                continue;
              }
              for (const call of calls) {
                // Strict: method harus cocok (tanpa fuzzy methodMismatch) agar
                // false positive lintas repo minim.
                const matched = providerRoutes.filter(
                  (r) => matchSegments(r.normalized, call.normalized) && (r.method === null || r.method === call.method)
                );
                if (matched.length === 0) continue;
                const evidence =
                  matched.length > 1
                    ? "AMBIGUOUS"
                    : !hasDynamicMarker(call.raw) &&
                      (matched[0].rawPath === call.raw || matched[0].rawPath.replace(/\/$/, "") === call.raw.replace(/\/$/, ""))
                      ? "EXTRACTED"
                      : "INFERRED";
                crossRepoHits.push({
                  repo: label,
                  file: relPath,
                  line: call.line,
                  method: call.method,
                  normalized: call.normalized,
                  evidence,
                });
                perRepo++;
                if (perRepo >= 10 || crossRepoHits.length >= 50) break;
              }
            }
            if (stale) staleRepos.add(path.basename(extRoot) || rel);
            // EXTRACTED dulu agar sinyal terkuat di atas.
            crossRepoHits.sort((a, b) =>
              (a.evidence === "EXTRACTED" ? 0 : a.evidence === "INFERRED" ? 1 : 2) -
              (b.evidence === "EXTRACTED" ? 0 : b.evidence === "INFERRED" ? 1 : 2)
            );
          } catch {
            crossRepoNotes.push(`${rel}: gagal dibaca — dilewati`);
          }
        }
        if (staleRepos.size > 0) {
          crossRepoNotes.push(`index basi (>7 hari / last_scan tak terbaca): ${[...staleRepos].join(", ")} — hasil bisa kurang lengkap, jalankan \`scopecairn scan\` di repo tersebut`);
        }
      }
      if (crossRepoHits.length > 0) {
        const reposHit = new Set(crossRepoHits.map((h) => h.repo)).size;
        reasons.push(`terpanggil lintas repo (${crossRepoHits.length} call site di ${reposHit} repo)`);
        if (risk === "LOW" && crossRepoHits.length >= 3) risk = "MED";
      }
    }

    if (opts.json) {
      console.log(JSON.stringify({
        target: centerLabel,
        directFiles: directFiles.slice(0, 15),
        detail: {
          importedBy: byRel("IMPORTS", "in"),
          calls: byRel("CALLS", "out"),
          calledBy: byRel("CALLS", "in"),
          queries: byRel("QUERIES", "out"),
          queriedBy: byRel("QUERIES", "in"),
          apiOut: byRel("CALLS_API", "out"),
          apiIn: byRel("CALLS_API", "in"),
        },
        indirect: [...indirect.values()].slice(0, 15),
        tests: testFiles,
        reachableTests: reachableTests.map(([f, d]) => ({ file: f, hops: d })),
        ui,
        apiClients: [...apiClientLabels, ...apiClientUi],
        crossRepo: crossRepoHits,
        crossRepoNotes,
        endpoints,
        models,
        risk,
        reasons,
        evidence: withLine(center.file, center.id),
        safetyGuidance: [
          "Rumuskan 1 fakta penjamin keamanan (The single safety fact it is safe because of)",
          "Buktikan fakta tersebut dengan menjalankan test terkait (--run-tests) sebelum merge",
        ],
      }, null, 2));
      return;
    }
    const lines: string[] = [
      `# Impact: ${centerLabel}`,
      ``,
      `## Direct (${directFiles.length} file)`,
      ...directFiles.slice(0, 15).map((f) => `- ${fmtFile(f)}`),
      ...(directFiles.length === 0 ? ["- (tidak ada)"] : []),
      ``,
      `## Detail`,
      `Diimpor oleh: ${byRel("IMPORTS", "in").join(", ") || "-"}`,
      `Memanggil: ${byRel("CALLS", "out").join(", ") || "-"}`,
      `Dipanggil oleh: ${byRel("CALLS", "in").join(", ") || "-"}`,
      `Tipe parameter: ${byRel("PARAM_TYPE", "out").join(", ") || "-"}`,
      `Tipe kembalian: ${byRel("RETURN_TYPE", "out").join(", ") || "-"}`,
      `Dipakai sebagai tipe: ${[...byRel("PARAM_TYPE", "in"), ...byRel("RETURN_TYPE", "in"), ...byRel("TYPED_AS", "in")].join(", ") || "-"}`,
      `Implementasi: ${[...byRel("IMPLEMENTS", "in"), ...byRel("EXTENDS", "in")].join(", ") || "-"}`,
      `Mengquery: ${byRel("QUERIES", "out").join(", ") || "-"}`,
      `Diquery oleh: ${byRel("QUERIES", "in").join(", ") || "-"}`,
      `Rute: ${[...byRel("ROUTES_TO", "out"), ...byRel("ROUTES_TO", "in")].join(", ") || "-"}`,
      `API keluar: ${byRel("CALLS_API", "out").join(", ") || "-"}`,
      `API masuk: ${byRel("CALLS_API", "in").join(", ") || "-"}`,
      ``,
      `## Indirect (${indirect.size})`,
      ...[...indirect.values()]
        .slice(0, 15)
        .map((v) => `- ${v.name} (${v.type}, ${v.file}) via ${v.via} [${v.evidence}]`),
      ...(indirect.size === 0 ? ["- (tidak ada)"] : []),
      ``,
      `## Tests`,
      ...testFiles.map((t) => `- ${t}`),
      ...(testFiles.length === 0 ? ["- (tidak ada test terkait di index)"] : []),
      ``,
      `## Tests via graph reachability (CALLS backward)`,
      ...reachableTests.map(([f, d]) => `- ${f} (≤${d} hop)`),
      ...(reachableTests.length === 0 ? ["- (tidak ada jalur CALLS ke test ditemukan)"] : []),
      ``,
      `## UI Components`,
      ...ui.map((u) => `- ${u}`),
      ...(ui.length === 0 ? ["- (tidak ada)"] : []),
      ``,
      `## Klien terpengaruh (CALLS_API)`,
      ...apiClientLabels.map((c) => `- ${c}`),
      ...(apiClientUi.length > 0 ? apiClientUi.map((u) => `- ${u} (via CALLS/IMPORTS 1 hop)`) : []),
      ...(apiClientLabels.length === 0 ? ["- (tidak ada klien CALLS_API)"] : []),
      ``,
      ...(wantCrossRepo
        ? [
            `## Cross-repo blast radius`,
            ...crossRepoHits
              .slice(0, 20)
              .map((h) => `- [${h.repo}] ${h.file}:${h.line} ${h.method} ${h.normalized} [${h.evidence}]`),
            ...(crossRepoHits.length === 0 ? ["- (tidak ada konsumen lintas repo terdeteksi)"] : []),
            ...crossRepoNotes.map((n) => `- ${n}`),
            ``,
          ]
        : []),
      `## Endpoints`,
      ...endpoints.map((e) => `- ${e}`),
      ...(endpoints.length === 0 ? ["- (tidak ada endpoint terkait)"] : []),
      ``,
      `## Models`,
      ...models.map((m) => `- ${m}`),
      ...(models.length === 0 ? ["- (tidak ada model terkait)"] : []),
      ``,
      `## Risk: ${risk}`,
      ...reasons.map((r) => `- ${r}`),
      `- Bukti pusat: ${withLine(center.file, center.id)}`,
      ``,
      `## Safety Checklist (Blast Radius Protocol)`,
      `- Rumuskan 1 fakta kunci penjamin keamanan (The single safety fact it is safe because of).`,
      `- Buktikan fakta tersebut dengan menjalankan test terkait (\`--run-tests\`) atau skrip verifikasi sebelum merge.`,
    ];
    console.log(lines.join("\n"));
  } finally {
    db.close();
  }
}
