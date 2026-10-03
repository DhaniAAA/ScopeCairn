import fs from "node:fs";
import path from "node:path";
import { MARKER, skillMd, workflowMd, allowlistGuide } from "./templates.js";
import { AGENT_MATRIX, findTarget, type AgentTarget } from "./matrix.js";
import { detectAgentDir, detectPrefix } from "./detect.js";

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
  prefix: string
): InstallOutcome {
  const abs = path.join(repoRoot, target.rel);
  const block = target.render(prefix);
  const finish = (how: InstallOutcome["how"]): InstallOutcome => ({
    agent: target.id,
    rel: target.rel,
    how,
  });
  if (target.mode === "new") {
    const existed = fs.existsSync(abs);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, block.endsWith("\n") ? block : block + "\n");
    return finish(existed ? "updated" : "generated");
  }
  if (fs.existsSync(abs)) {
    const cur = fs.readFileSync(abs, "utf8");
    if (cur.includes(MARKER)) {
      const { next } = removeManagedBlock(cur, (p) => target.render(p));
      fs.writeFileSync(abs, (next + "\n\n" + block).trimEnd() + "\n");
      return finish("updated");
    }
    // Tanpa marker pun bersihkan dulu sisa yatim versi lama agar tak ganda.
    const { next, changed } = removeManagedBlock(cur, (p) => target.render(p));
    const base = changed ? next : cur;
    fs.writeFileSync(abs, (base.trimEnd() + "\n\n" + block).trimEnd() + "\n");
    return finish("extended");
  }
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, block.endsWith("\n") ? block : block + "\n");
  return finish("generated");
}

/**
 * Cabut blok marker secara tepat: cocok persis dulu (kedua varian prefix),
 * lalu pola berjangkar pada baris terakhir template. Kembalikan teks bersih
 * (newline berlebih dilipat). `changed=false` bila tak ada yang cocok —
 * pemanggil wajib melapor jujur, bukan klaim "removed".
 */
export function removeManagedBlock(
  content: string,
  render: (prefix: string) => string
): { next: string; changed: boolean } {
  for (const p of ["scopecairn", "npx scopecairn"]) {
    for (const cand of [render(p), render(p).trimEnd(), render(p).trimEnd() + "\n"]) {
      if (cand && content.includes(cand)) {
        return { next: foldBlank(content.split(cand).join("")), changed: true };
      }
    }
  }
  const anchored = new RegExp(
    `\\n*${MARKER}\\n# ScopeCairn[\\s\\S]*?pertanyaan non-coding\\.[ \\t]*(\\n|$)`,
    ""
  );
  if (anchored.test(content)) {
    return { next: foldBlank(content.replace(anchored, "\n")), changed: true };
  }
  // Yatim versi lama (marker hilang, badan tersisa): jangkar pada judul +
  // baris terakhir template yang khas. Hapus SEMUA kemunculan.
  const orphan = /# ScopeCairn[\s\S]*?pertanyaan non-coding\.[ \t]*(\n|$)/g;
  if (orphan.test(content)) {
    return { next: foldBlank(content.replace(orphan, "")), changed: true };
  }
  return { next: content, changed: false };
}

function foldBlank(s: string): string {
  return s.replace(/\n{3,}/g, "\n\n").trim();
}

/** Lepas satu target: hapus file milik penuh, cabut blok marker dari milik user. */
export function uninstallTarget(repoRoot: string, target: AgentTarget): InstallOutcome {
  const abs = path.join(repoRoot, target.rel);
  const finish = (how: InstallOutcome["how"]): InstallOutcome => ({
    agent: target.id,
    rel: target.rel,
    how,
  });
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
  while (cur.startsWith(stop) && cur !== stop) {
    try {
      fs.rmdirSync(cur);
    } catch {
      return;
    }
    cur = path.dirname(cur);
  }
}

// Antigravity = Skill + Workflow + panduan allowlist (AI-7, §8.6).
export function installAntigravity(repoRoot: string, prefix = detectPrefix(repoRoot)): string[] {
  const agentDir = detectAgentDir(repoRoot);
  const out: string[] = [];
  const skillPath = path.join(repoRoot, agentDir, "skills", "scopecairn", "SKILL.md");
  fs.mkdirSync(path.dirname(skillPath), { recursive: true });
  fs.writeFileSync(skillPath, skillMd(prefix));
  out.push(`Skill installed (${path.relative(repoRoot, skillPath)})`);
  const wfPath = path.join(repoRoot, "workflows", "scopecairn.md");
  fs.mkdirSync(path.dirname(wfPath), { recursive: true });
  fs.writeFileSync(wfPath, workflowMd(prefix));
  out.push(`Workflow installed (${path.relative(repoRoot, wfPath)})`);
  return out;
}

export function uninstallAntigravity(repoRoot: string): string[] {
  const out: string[] = [];
  for (const dir of [".agents", ".agent"]) {
    const p = path.join(repoRoot, dir, "skills", "scopecairn", "SKILL.md");
    if (fs.existsSync(p)) {
      fs.rmSync(p, { force: true });
      pruneEmptyDirs(path.dirname(p), repoRoot);
      out.push(`Skill removed (${path.relative(repoRoot, p)})`);
    }
  }
  const wf = path.join(repoRoot, "workflows", "scopecairn.md");
  if (fs.existsSync(wf)) {
    const text = fs.readFileSync(wf, "utf8");
    if (text.includes("scopecairn")) {
      fs.rmSync(wf, { force: true });
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
