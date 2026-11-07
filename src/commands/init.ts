import fs from "node:fs";
import path from "node:path";
import { scanRepository } from "../scanner.js";
import { detectPrefix } from "../integrate/detect.js";
import { AGENT_MATRIX, findTarget, parseAgentsOption, type AgentTarget } from "../integrate/matrix.js";
import { installAntigravity, installTarget, allowlistText } from "../integrate/install.js";
import { ensureSessionGitignored } from "./session.js";
import { BYPASS_LIMITATION_NOTE } from "../scope/testGate.js";

export interface InitOptions {
  agents?: string;
  hooks?: boolean;
  ci?: boolean;
}

export const CI_WORKFLOW_REL = ".github/workflows/scopecairn.yml";

export const CI_WORKFLOW_TEMPLATE = `name: ScopeCairn Verify
on: [push, pull_request]
jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - run: npm install -g scopecairn@latest
      - run: scopecairn verify --test-gate --base origin/main
`;

export const HOOK_MARKER_START = "# scopecairn:managed-hook";
export const HOOK_MARKER_END = "# /scopecairn:managed-hook";

export function installCiWorkflow(repoRoot: string, prefix = detectPrefix(repoRoot)): string {
  const outPath = path.join(repoRoot, ...CI_WORKFLOW_REL.split("/"));
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const body = CI_WORKFLOW_TEMPLATE.replace(/scopecairn verify/g, `${prefix} verify`);
  fs.writeFileSync(outPath, body, "utf8");
  return `CI workflow installed (${CI_WORKFLOW_REL})`;
}

export function installPreCommitHook(repoRoot: string, prefix = detectPrefix(repoRoot)): string {
  const gitDir = path.join(repoRoot, ".git");
  if (!fs.existsSync(gitDir)) return "Pre-commit hook skipped (.git not found)";
  const hooksDir = path.join(gitDir, "hooks");
  fs.mkdirSync(hooksDir, { recursive: true });
  const hookPath = path.join(hooksDir, "pre-commit");
  const block = [
    HOOK_MARKER_START,
    `# Catatan: agen dapat melewati hook lokal dengan --no-verify; jalankan pemeriksaan yang sama di CI:`,
    `#   ${prefix} verify --test-gate --base origin/main`,
    `${prefix} verify --no-strict --test-gate`,
    HOOK_MARKER_END,
  ].join("\n");
  if (fs.existsSync(hookPath)) {
    const cur = fs.readFileSync(hookPath, "utf8").replace(/\r\n/g, "\n");
    const re = new RegExp(`\\n*${HOOK_MARKER_START}[\\s\\S]*?${HOOK_MARKER_END}\\n*`, "g");
    const cleaned = cur.replace(re, "\n").trimEnd();
    fs.writeFileSync(hookPath, `${cleaned}\n\n${block}\n`, { mode: 0o755 });
  } else {
    fs.writeFileSync(hookPath, `#!/bin/sh\n${block}\n`, { mode: 0o755 });
  }
  try {
    fs.chmodSync(hookPath, 0o755);
  } catch {
    // ignore chmod on Windows if unsupported
  }
  return "Pre-commit hook installed (.git/hooks/pre-commit)";
}

export function uninstallPreCommitHook(repoRoot: string): string {
  const hookPath = path.join(repoRoot, ".git", "hooks", "pre-commit");
  if (!fs.existsSync(hookPath)) return "Pre-commit hook absent";
  const cur = fs.readFileSync(hookPath, "utf8").replace(/\r\n/g, "\n");
  if (!cur.includes(HOOK_MARKER_START)) return "Pre-commit hook skipped (not managed by ScopeCairn)";
  const re = new RegExp(`\\n*${HOOK_MARKER_START}[\\s\\S]*?${HOOK_MARKER_END}\\n*`, "g");
  const rest = cur.replace(re, "\n").trim();
  if (!rest || rest === "#!/bin/sh" || rest === "#!/usr/bin/env sh") {
    fs.rmSync(hookPath, { force: true });
    return "Pre-commit hook removed";
  }
  fs.writeFileSync(hookPath, `${rest}\n`, { mode: 0o755 });
  return "Pre-commit hook cleaned";
}

// `scopecairn init` (AI-1): indexing awal + Skill/Workflow Antigravity +
// matriks agent yang diminta/terdeteksi. TIDAK menulis AGENTS.md/CLAUDE.md:
// file itu milik detail repo user — distribusi lewat skill tiap agent.
export async function cmdInit(repoRoot: string, opts: InitOptions = {}): Promise<void> {
  console.log("ScopeCairn");
  console.log("✓ Repository detected");

  const stats = await scanRepository(repoRoot);
  console.log(`✓ ${stats.sourceFiles} source files`);
  if (stats.metaFiles > 0) console.log(`✓ ${stats.metaFiles} config/schema files`);
  console.log(`✓ ${stats.symbols} symbols`);
  console.log(`✓ ${stats.relationships} relationships`);
  if (stats.adapters.length > 0) console.log(`✓ adapters: ${stats.adapters.join(", ")}`);

  const prefix = detectPrefix(repoRoot);

  const requested = parseAgentsOption(opts.agents);
  const targets =
    requested === "all"
      ? [...AGENT_MATRIX]
      : requested && requested.length > 0
        ? withCore(requested)
        : withDetected(repoRoot);
  for (const t of targets) {
    const r = installTarget(repoRoot, t, prefix);
    console.log(`✓ ${t.label}: ${r.rel} (${r.how})`);
    if (t.companionRule) {
      console.log(`✓ ${t.label} (Rule mirroring): ${t.companionRule.rel}`);
    }
  }

  for (const line of installAntigravity(repoRoot, prefix)) console.log(`✓ ${line}`);
  ensureSessionGitignored(repoRoot);
  if (opts.hooks) {
    console.log(`✓ ${installPreCommitHook(repoRoot, prefix)}`);
    console.log(`! ${BYPASS_LIMITATION_NOTE}`);
  }
  if (opts.ci) {
    console.log(`✓ ${installCiWorkflow(repoRoot, prefix)}`);
  }

  console.log("Ready.");
  console.log("");
  console.log(allowlistText(repoRoot));
}

function withCore(ids: string[]): AgentTarget[] {
  const out: AgentTarget[] = [];
  for (const id of ids) {
    const t = findTarget(id);
    if (!t) {
      console.log(`! Unknown agent "${id}" (pilihan: ${AGENT_MATRIX.map((x) => x.id).join(", ")}, all)`);
      continue;
    }
    if (!out.includes(t)) out.push(t);
  }
  return out;
}

function withDetected(repoRoot: string) {
  const targets = [];
  for (const t of AGENT_MATRIX) {
    if (fs.existsSync(path.join(repoRoot, t.presentMarker))) targets.push(t);
  }
  return targets;
}
