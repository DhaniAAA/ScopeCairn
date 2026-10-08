import { openDb } from "../db.js";
import { logInvocation } from "../invocations.js";
import { refreshIndex } from "../refresh.js";
import { findSymbols, neighbors } from "../graph.js";
import { isProtected, loadProtectedPatterns } from "../scope/protected.js";

// Change Impact Analyzer (PRD FR-08).
// Input: path file ("src/x.ts"), atau nama simbol ("RequestService").
// Output: dampak langsung, tak langsung (2-hop), test, komponen UI.

export async function cmdImpact(
  repoRoot: string,
  target: string,
  opts: { noRefresh?: boolean } = {}
): Promise<void> {
  if (!opts.noRefresh) await refreshIndex(repoRoot);

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
      if (out.length === 0 && fileHit != null && (rel === "CALLS" || rel === "USES" || rel === "QUERIES")) {
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
      `Mengquery: ${byRel("QUERIES", "out").join(", ") || "-"}`,
      `Diquery oleh: ${byRel("QUERIES", "in").join(", ") || "-"}`,
      `Rute: ${[...byRel("ROUTES_TO", "out"), ...byRel("ROUTES_TO", "in")].join(", ") || "-"}`,
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
    ];
    console.log(lines.join("\n"));
  } finally {
    db.close();
  }
}
