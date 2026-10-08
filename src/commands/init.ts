import fs from "node:fs";
import path from "node:path";
import { scanRepository } from "../scanner.js";
import { detectPrefix } from "../integrate/detect.js";
import { AGENT_MATRIX, findTarget, parseAgentsOption, type AgentTarget } from "../integrate/matrix.js";
import { installAntigravity, installTarget, allowlistText } from "../integrate/install.js";

export interface InitOptions {
  agents?: string;
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
  }

  for (const line of installAntigravity(repoRoot, prefix)) console.log(`✓ ${line}`);

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
