import fs from "node:fs";
import path from "node:path";
import { dataDir, dbPath, openDb } from "../db.js";
import { checkTreeSitter } from "../treesitter.js";
import { detectAgentDir, detectPrefix, extractPrefixUsed } from "../integrate/detect.js";
import { MARKER } from "../integrate/templates.js";
import { AGENT_MATRIX } from "../integrate/matrix.js";
import { logError } from "../log.js";

function tick(ok: boolean): string {
  return ok ? "✓" : "✗";
}

export async function cmdDoctor(repoRoot: string, opts?: { verbose?: boolean }): Promise<void> {
  const nodeOk = Number(process.versions.node.split(".")[0]) >= 20;
  console.log(`${tick(nodeOk)} Node.js ${process.version} (need >=20)`);

  let sqliteOk = false;
  try {
    const { createRequire } = await import("node:module");
    const req = createRequire(import.meta.url);
    const m = req("node:" + "sqlite") as { DatabaseSync: unknown };
    sqliteOk = typeof m.DatabaseSync === "function";
  } catch (err) {
    sqliteOk = false;
    logError("doctor", err, repoRoot);
    if (opts?.verbose) console.error(err);
  }
  console.log(`${tick(sqliteOk)} SQLite (node:sqlite built-in)`);

  const ts = await checkTreeSitter();
  console.log(`${tick(ts.ok)} Tree-sitter ${ts.detail}`);

  let dbOk = false;
  let graphDetail = "";
  try {
    const db = openDb(repoRoot);
    db.prepare(`SELECT 1`).get();
    const s = (db.prepare(`SELECT COUNT(*) AS n FROM symbols`).get() as { n: number }).n;
    const r = (db.prepare(`SELECT COUNT(*) AS n FROM relationships`).get() as { n: number }).n;
    db.close();
    dbOk = fs.existsSync(dbPath(repoRoot));
    graphDetail = ` (${s} symbols, ${r} rels)`;
  } catch (err) {
    dbOk = false;
    logError("doctor", err, repoRoot);
    if (opts?.verbose) console.error(err);
  }
  console.log(`${tick(dbOk)} Database ${dbPath(repoRoot)}${graphDetail}`);

  // Graphify Engine: circular dependencies + critical single points of failure.
  try {
    const db = openDb(repoRoot);
    try {
      const { refreshCycles, getCycles, describeCycle } = await import("../graph/cycles.js");
      const { ensureMetrics, topByPageRank } = await import("../graph/metrics.js");
      const cycles = getCycles(db, 5);
      if (cycles.length === 0) {
        // Cache kosong → hitung malas sekali (Tarjan O(N+M)).
        try {
          refreshCycles(db);
        } catch (err) {
          logError("doctor", err, repoRoot);
          if (opts?.verbose) console.error(err);
        }
      }
      const found = getCycles(db, 5);
      console.log(`${tick(found.length === 0)} Circular dependencies (${found.length} cycle(s))`);
      for (const c of found.slice(0, 3)) {
        console.log(`  ~ cycle[${c.length}]: ${describeCycle(db, c)}`);
      }
      ensureMetrics(db);
      const gods = topByPageRank(db, 3);
      if (gods.length > 0) {
        console.log(`i Critical hotspots (PageRank):`);
        for (const g of gods) {
          console.log(
            `  ! ${g.name} (${g.type}, ${g.file}) pr=${g.pagerank.toFixed(4)} ` +
              `in=${g.inDegree} out=${g.outDegree}`
          );
        }
      }
    } finally {
      db.close();
    }
  } catch (err) {
    logError("doctor", err, repoRoot);
    if (opts?.verbose) console.error(err);
    console.log(`i Graph metrics unavailable (run \`scopecairn scan\` first)`);
  }

  const protPath = path.join(dataDir(repoRoot), "protected.yml");
  console.log(`${tick(fs.existsSync(protPath))} Protected ${protPath}`);

  // AI-3: file integrasi di lokasi yang benar + prefix konsisten (AI-9).
  // mode=new (skill/command milik penuh): keberadaan file = terpasang.
  // mode=merge (aturan menumpang file user): wajib ada marker.
  const expectedPrefix = detectPrefix(repoRoot);
  const agentDir = detectAgentDir(repoRoot);
  let prefixOk = true;
  let matrixOk = 0;
  for (const t of AGENT_MATRIX) {
    const abs = path.join(repoRoot, t.rel);
    if (!fs.existsSync(abs)) continue;
    let text: string;
    try {
      text = fs.readFileSync(abs, "utf8");
    } catch {
      console.log(`✗ Tidak bisa membaca ${t.rel} — dilewati.`);
      continue;
    }
    if (t.mode === "merge" && !text.includes(MARKER)) continue;
    matrixOk++;
    const used = extractPrefixUsed(text);
    if (used && used !== expectedPrefix) {
      prefixOk = false;
      console.log(
        `✗ Prefix tak konsisten di ${t.rel}: memakai \`${used}\`, ` +
          `instalasi terdeteksi \`${expectedPrefix}\`. Jalankan ulang \`scopecairn init\`.`
      );
    }
  }
  console.log(`${tick(matrixOk > 0)} Agent matrix (${matrixOk}/${AGENT_MATRIX.length} target terpasang)`);
  if (matrixOk === 0) {
    console.log(`  Jalankan \`scopecairn init --agents all\` untuk memasang semua.`);
  } else if (prefixOk) {
    console.log(`✓ Prefix konsisten (\`${expectedPrefix} context\`)`);
  }

  // Skill Antigravity (AI-2) tetap dicek terpisah dari matriks.
  const skillPath = path.join(repoRoot, agentDir, "skills", "scopecairn", "SKILL.md");
  const skillOk = fs.existsSync(skillPath);
  console.log(`${tick(skillOk)} Skill (${agentDir}/skills/scopecairn/SKILL.md)`);

  const wfPath = path.join(repoRoot, "workflows", "scopecairn.md");
  console.log(`${tick(fs.existsSync(wfPath))} Workflow (workflows/scopecairn.md, opsional)`);

  // §8.6: pengingat yang tak bisa dicek otomatis.
  console.log(`i Strict Mode mengabaikan allowlist — semua perintah tetap perlu persetujuan.`);

  const healthy = nodeOk && sqliteOk && ts.ok && dbOk && (matrixOk > 0 || skillOk) && prefixOk;
  console.log(`Status: ${healthy ? "HEALTHY" : "DEGRADED (see ✗ above)"}`);
}
