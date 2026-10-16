import fs from "node:fs";
import path from "node:path";
import { dataDir, dbPath, openDb } from "../db.js";
import { checkTreeSitter } from "../treesitter.js";
import { detectAgentDir, detectPrefix, extractPrefixUsed } from "../integrate/detect.js";
import { MARKER } from "../integrate/templates.js";
import { AGENT_MATRIX } from "../integrate/matrix.js";
import {
  auditKnowledgeFiles,
  antigravityKnowledgeSkillPath,
  antigravityWorkflowPath,
} from "../integrate/install.js";
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

  // Analogi riwayat: jumlah commit terindeks + peringatan shallow clone.
  // Repo tanpa git: dilewati diam-diam (bukan error).
  try {
    const db = openDb(repoRoot);
    try {
      let n = 0;
      try {
        n = (db.prepare(`SELECT COUNT(*) AS n FROM commits`).get() as { n: number }).n;
      } catch {
        n = 0;
      }
      const { isShallowRepo } = await import("../retrieval/history/extractor.js");
      let shallow = false;
      try {
        shallow = isShallowRepo(repoRoot);
      } catch {
        shallow = false;
      }
      if (n > 0) console.log(`i History: ${n} commit terindeks`);
      else console.log(`i History: belum terindeks (jalankan \`scopecairn scan\`)`);
      if (shallow) console.log(`! Clone dangkal terdeteksi — riwayat parsial, analog bisa tak lengkap.`);
    } finally {
      db.close();
    }
  } catch (err) {
    logError("doctor", err, repoRoot);
    if (opts?.verbose) console.error(err);
  }

  const protPath = path.join(dataDir(repoRoot), "protected.yml");
  console.log(`${tick(fs.existsSync(protPath))} Protected ${protPath}`);

  // CALLS_API: edge klien→route + route yang tidak ditemukan klien.
  try {
    const db = openDb(repoRoot);
    try {
      const n = (db.prepare(`SELECT COUNT(*) AS n FROM relationships WHERE relationship_type = 'CALLS_API'`).get() as { n: number }).n;
      console.log(`i CALLS_API edges: ${n}`);
      const orphans = db
        .prepare(
          `SELECT s.name AS name, f.path AS file FROM symbols s
           JOIN files f ON f.id = s.file_id
           WHERE s.type = 'route' AND s.id NOT IN (SELECT target_id FROM relationships WHERE relationship_type = 'CALLS_API')
           LIMIT 10`
        )
        .all() as { name: string; file: string }[];
      if (orphans.length > 0) {
        console.log(`i Route tidak ditemukan klien (${orphans.length} ditampilkan, maks 10):`);
        for (const o of orphans) console.log(`  ~ ${o.name} — ${o.file}`);
      } else if (n > 0) {
        console.log(`✓ Semua route punya klien CALLS_API`);
      }
    } finally {
      db.close();
    }
  } catch (err) {
    logError("doctor", err, repoRoot);
    if (opts?.verbose) console.error(err);
  }

  // AI-3: file integrasi di lokasi yang benar + prefix konsisten (AI-9).
  // mode=new (skill/command milik penuh): keberadaan file = terpasang.
  // mode=merge (aturan menumpang file user): wajib ada marker.
  const expectedPrefix = detectPrefix(repoRoot);
  const agentDir = detectAgentDir(repoRoot);
  let prefixOk = true;
  let matrixOk = 0;
  // Pesan sama untuk file utama dan file knowledge (extra).
  const reportPrefixMismatch = (rel: string, used: string): void => {
    prefixOk = false;
    console.log(
      `✗ Prefix tak konsisten di ${rel}: memakai \`${used}\`, ` +
        `instalasi terdeteksi \`${expectedPrefix}\`. Jalankan ulang \`scopecairn init\`.`
    );
  };
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
      reportPrefixMismatch(t.rel, used);
    }
  }
  console.log(`${tick(matrixOk > 0)} Agent matrix (${matrixOk}/${AGENT_MATRIX.length} target terpasang)`);

  // File knowledge (extra) tiap target terpasang — hilang = sisa upgrade lama.
  // Dijalankan SEBELUM verdict prefix/knowledge dicetak agar tidak kontradiktif.
  const audit = auditKnowledgeFiles(repoRoot, AGENT_MATRIX, expectedPrefix);
  for (const m of audit.missing) {
    console.log(`✗ Knowledge file hilang: ${m.rel} — jalankan \`scopecairn ${m.agent} install\`.`);
  }
  for (const p of audit.prefixIssues) {
    reportPrefixMismatch(p.rel, p.used);
  }
  if (matrixOk === 0) {
    console.log(`  Jalankan \`scopecairn init --agents all\` untuk memasang semua.`);
  } else if (prefixOk) {
    console.log(`✓ Prefix konsisten (\`${expectedPrefix} context\`)`);
  }
  if (audit.total > 0) {
    console.log(`${tick(audit.ok === audit.total)} Knowledge files (${audit.ok}/${audit.total})`);
  }

  // Skill Antigravity (AI-2) tetap dicek terpisah dari matriks.
  const skillPath = path.join(repoRoot, agentDir, "skills", "scopecairn", "SKILL.md");
  const skillOk = fs.existsSync(skillPath);
  console.log(`${tick(skillOk)} Skill (${agentDir}/skills/scopecairn/SKILL.md)`);

  const kSkillPath = antigravityKnowledgeSkillPath(repoRoot);
  const kSkillOk = fs.existsSync(kSkillPath);
  console.log(`${tick(kSkillOk)} Knowledge skill (${path.relative(repoRoot, kSkillPath)})`);
  if (skillOk && !kSkillOk) {
    console.log(`  Jalankan \`scopecairn antigravity install\` untuk memasang knowledge skill.`);
  }

  const wfPath = antigravityWorkflowPath(repoRoot);
  console.log(`${tick(fs.existsSync(wfPath))} Workflow (${path.relative(repoRoot, wfPath)}, opsional)`);

  // §8.6: pengingat yang tak bisa dicek otomatis.
  console.log(`i Strict Mode mengabaikan allowlist — semua perintah tetap perlu persetujuan.`);

  const knowledgeHealthy = audit.ok === audit.total && (!skillOk || kSkillOk);
  const healthy =
    nodeOk && sqliteOk && ts.ok && dbOk && (matrixOk > 0 || skillOk) && prefixOk && knowledgeHealthy;
  console.log(`Status: ${healthy ? "HEALTHY" : "DEGRADED (see ✗ above)"}`);
}
