import fs from "node:fs";
import path from "node:path";
import {
  MARKER,
  skillMd,
  workflowMd,
  allowlistGuide,
  knowledgeSkillMd,
} from "./templates.js";
import { AGENT_MATRIX, findTarget, type AgentTarget } from "./matrix.js";
import { detectAgentDir, detectPrefix, extractPrefixUsed } from "./detect.js";

// Installer per-agent: `scopecairn <agent> install|uninstall`.
// init --agents menumpang fungsi yang sama agar satu sumber kebenaran.

export interface InstallOutcome {
  agent: string;
  rel: string;
  how: "generated" | "updated" | "extended" | "removed" | "absent" | "skipped";
}

/** Tulis/merge satu target matriks. */
export function installTarget(
  repoRoot: string,
  target: AgentTarget,
  prefix: string,
): InstallOutcome {
  const abs = path.join(repoRoot, target.rel);
  const block = target.render(prefix);
  const finish = (how: InstallOutcome["how"]): InstallOutcome => ({
    agent: target.id,
    rel: target.rel,
    how,
  });
  let how: InstallOutcome["how"];
  if (target.mode === "new") {
    const existed = fs.existsSync(abs);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, block.endsWith("\n") ? block : block + "\n");
    how = existed ? "updated" : "generated";
  } else if (fs.existsSync(abs)) {
    const cur = fs.readFileSync(abs, "utf8");
    if (cur.includes(MARKER)) {
      const { next } = removeManagedBlock(cur, (p) => target.render(p));
      fs.writeFileSync(abs, (next + "\n\n" + block).trimEnd() + "\n");
      how = "updated";
    } else {
      // Tanpa marker pun bersihkan dulu sisa yatim versi lama agar tak ganda.
      const { next, changed } = removeManagedBlock(cur, (p) => target.render(p));
      const base = changed ? next : cur;
      fs.writeFileSync(abs, (base.trimEnd() + "\n\n" + block).trimEnd() + "\n");
      how = "extended";
    }
  } else {
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, block.endsWith("\n") ? block : block + "\n");
    how = "generated";
  }
  // File extra (knowledge skill) milik penuh ScopeCairn — ditulis untuk mode
  // "new" maupun "merge" (pada merge, hanya blok utama yang menumpang file user).
  writeExtras(repoRoot, target, prefix);
  return finish(how);
}

/** Tulis file extra target (knowledge skill) — deterministik, milik ScopeCairn. */
function writeExtras(repoRoot: string, target: AgentTarget, prefix: string): void {
  for (const e of target.extra ?? []) {
    const eAbs = path.join(repoRoot, e.rel);
    fs.mkdirSync(path.dirname(eAbs), { recursive: true });
    const eBlock = e.render(prefix);
    fs.writeFileSync(eAbs, eBlock.endsWith("\n") ? eBlock : eBlock + "\n");
  }
}

/** Hapus file extra target; true bila ada yang benar-benar dihapus. */
function removeExtras(repoRoot: string, target: AgentTarget): boolean {
  let removed = false;
  for (const e of target.extra ?? []) {
    const eAbs = path.join(repoRoot, e.rel);
    if (!fs.existsSync(eAbs)) continue;
    fs.rmSync(eAbs, { force: true });
    pruneEmptyDirs(path.dirname(eAbs), repoRoot);
    removed = true;
  }
  return removed;
}

/**
 * Cabut blok marker secara tepat: cocok persis dulu (kedua varian prefix),
 * lalu pola berjangkar pada baris terakhir template. Kembalikan teks bersih
 * (newline berlebih dilipat). `changed=false` bila tak ada yang cocok —
 * pemanggil wajib melapor jujur, bukan klaim "removed".
 */
export function removeManagedBlock(
  content: string,
  render: (prefix: string) => string,
): { next: string; changed: boolean } {
  for (const p of ["scopecairn", "npx scopecairn"]) {
    for (const cand of [
      render(p),
      render(p).trimEnd(),
      render(p).trimEnd() + "\n",
    ]) {
      if (cand && content.includes(cand)) {
        return { next: foldBlank(content.split(cand).join("")), changed: true };
      }
    }
  }
  const anchored = new RegExp(
    `\\n*${MARKER}\\n# ScopeCairn[\\s\\S]*?(?:pertanyaan non-coding|context berikutnya)\\.[ \\t]*(\\n|$)`,
    "",
  );
  if (anchored.test(content)) {
    return { next: foldBlank(content.replace(anchored, "\n")), changed: true };
  }
  // Yatim versi lama (marker hilang, badan tersisa): jangkar pada judul +
  // baris terakhir template yang khas. Hapus SEMUA kemunculan.
  const orphan = /# ScopeCairn[\s\S]*?(?:pertanyaan non-coding|context berikutnya)\.[ \t]*(\n|$)/g;
  if (orphan.test(content)) {
    return { next: foldBlank(content.replace(orphan, "")), changed: true };
  }
  return { next: content, changed: false };
}

function foldBlank(s: string): string {
  return s.replace(/\n{3,}/g, "\n\n").trim();
}

/** Lepas satu target: hapus file milik penuh, cabut blok marker dari milik user. */
export function uninstallTarget(
  repoRoot: string,
  target: AgentTarget,
): InstallOutcome {
  const abs = path.join(repoRoot, target.rel);
  const finish = (how: InstallOutcome["how"]): InstallOutcome => ({
    agent: target.id,
    rel: target.rel,
    how,
  });
  // File extra milik penuh ScopeCairn: selalu dibersihkan lebih dulu, bahkan
  // bila file utama sudah hilang — jangan tinggalkan sisa yatim.
  // `how` hanya melaporkan status file UTAMA; extra yang ikut dihapus tidak
  // boleh membuat klaim "removed" untuk file yang tidak disentuh.
  removeExtras(repoRoot, target);
  if (!fs.existsSync(abs)) return finish("absent");
  if (target.mode === "new") {
    fs.rmSync(abs, { force: true });
    pruneEmptyDirs(path.dirname(abs), repoRoot);
    return finish("removed");
  }
  const cur = fs.readFileSync(abs, "utf8");
  if (!cur.includes(MARKER)) return finish("skipped");
  const render = (p: string): string => {
    const t = resolveAgent(target.id);
    return t ? t.render(p) : "";
  };
  const { next, changed } = removeManagedBlock(cur, render);
  if (!changed) return finish("skipped");
  if (!next) {
    fs.rmSync(abs, { force: true });
    return finish("removed");
  }
  fs.writeFileSync(abs, next + "\n");
  return finish("removed");
}

function pruneEmptyDirs(dir: string, stop: string): void {
  let cur = dir;
  while (cur !== stop && cur.toLowerCase().startsWith(stop.toLowerCase())) {
    try {
      fs.rmdirSync(cur);
    } catch {
      return;
    }
    cur = path.dirname(cur);
  }
}

// Antigravity = Skill + Workflow + panduan allowlist (AI-7, §8.6).
export function installAntigravity(
  repoRoot: string,
  prefix = detectPrefix(repoRoot),
): string[] {
  const agentDir = detectAgentDir(repoRoot);
  const out: string[] = [];
  const skillPath = path.join(
    repoRoot,
    agentDir,
    "skills",
    "scopecairn",
    "SKILL.md",
  );
  fs.mkdirSync(path.dirname(skillPath), { recursive: true });
  fs.writeFileSync(skillPath, skillMd(prefix));
  out.push(`Skill installed (${path.relative(repoRoot, skillPath)})`);
  const kPath = antigravityKnowledgeSkillPath(repoRoot);
  fs.mkdirSync(path.dirname(kPath), { recursive: true });
  fs.writeFileSync(kPath, knowledgeSkillMd(prefix));
  out.push(`Knowledge skill installed (${path.relative(repoRoot, kPath)})`);
  const wfPath = antigravityWorkflowPath(repoRoot);
  fs.mkdirSync(path.dirname(wfPath), { recursive: true });
  fs.writeFileSync(wfPath, workflowMd(prefix));
  out.push(`Workflow installed (${path.relative(repoRoot, wfPath)})`);
  return out;
}

/** Path skill knowledge Antigravity (installer + doctor dari sumber yang sama). */
export function antigravityKnowledgeSkillPath(repoRoot: string): string {
  return path.join(
    repoRoot,
    detectAgentDir(repoRoot),
    "skills",
    "scopecairn-knowledge",
    "SKILL.md",
  );
}

/** Path workflow Antigravity — di dalam agent dir: `.agents/workflows/scopecairn.md`. */
export function antigravityWorkflowPath(repoRoot: string): string {
  return path.join(
    repoRoot,
    detectAgentDir(repoRoot),
    "workflows",
    "scopecairn.md",
  );
}

export function uninstallAntigravity(repoRoot: string): string[] {
  const out: string[] = [];
  for (const dir of [".agents", ".agent"]) {
    for (const [name, label] of [
      ["scopecairn", "Skill"],
      ["scopecairn-knowledge", "Knowledge skill"],
    ] as const) {
      const p = path.join(repoRoot, dir, "skills", name, "SKILL.md");
      if (!fs.existsSync(p)) continue;
      fs.rmSync(p, { force: true });
      pruneEmptyDirs(path.dirname(p), repoRoot);
      out.push(`${label} removed (${path.relative(repoRoot, p)})`);
    }
  }
  for (const wf of [
    path.join(repoRoot, ".agents", "workflows", "scopecairn.md"),
    path.join(repoRoot, ".agent", "workflows", "scopecairn.md"),
    // Legacy: versi lama menulis di root `workflows/` — bersihkan saat uninstall.
    path.join(repoRoot, "workflows", "scopecairn.md"),
  ]) {
    if (!fs.existsSync(wf)) continue;
    const text = fs.readFileSync(wf, "utf8");
    if (text.includes("scopecairn")) {
      fs.rmSync(wf, { force: true });
      pruneEmptyDirs(path.dirname(wf), repoRoot);
      out.push(`Workflow removed (${path.relative(repoRoot, wf)})`);
    } else {
      out.push(`Workflow skipped (bukan milik ScopeCairn)`);
    }
  }
  if (out.length === 0) out.push("Nothing installed.");
  return out;
}

export function agentIds(): string[] {
  return ["antigravity", ...AGENT_MATRIX.map((t) => t.id)];
}

export function allowlistText(repoRoot: string): string {
  return allowlistGuide(detectPrefix(repoRoot));
}

export function resolveAgent(id: string): AgentTarget | undefined {
  return findTarget(id);
}

/** Audit file knowledge (extra) — dipakai doctor. Hanya target yang file
 *  utamanya terpasang; target yang belum dipasang bukan masalah. */
export interface KnowledgeAudit {
  total: number;
  ok: number;
  missing: Array<{ agent: string; rel: string }>;
  prefixIssues: Array<{ agent: string; rel: string; used: string }>;
}

export function auditKnowledgeFiles(
  repoRoot: string,
  targets: AgentTarget[],
  expectedPrefix: string,
): KnowledgeAudit {
  const audit: KnowledgeAudit = { total: 0, ok: 0, missing: [], prefixIssues: [] };
  for (const t of targets) {
    let main: string | null = null;
    try {
      main = fs.readFileSync(path.join(repoRoot, t.rel), "utf8");
    } catch {
      continue; // belum terpasang
    }
    // Definisi "terpasang" harus sama dengan loop matrix di doctor: file merge
    // (mis. copilot-instructions.md milik user) hanya dihitung bila marker ada.
    if (t.mode === "merge" && !main.includes(MARKER)) continue;
    for (const e of t.extra ?? []) {
      audit.total++;
      let text: string | null = null;
      try {
        text = fs.readFileSync(path.join(repoRoot, e.rel), "utf8");
      } catch {
        text = null;
      }
      if (text === null) {
        audit.missing.push({ agent: t.id, rel: e.rel });
        continue;
      }
      const used = extractPrefixUsed(text);
      if (used && used !== expectedPrefix) {
        audit.prefixIssues.push({ agent: t.id, rel: e.rel, used });
        continue;
      }
      audit.ok++;
    }
  }
  return audit;
}
