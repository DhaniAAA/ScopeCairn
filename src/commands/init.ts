import fs from "node:fs";
import path from "node:path";
import { scanRepository } from "../scanner.js";
import { detectPrefix } from "../integrate/detect.js";
import { AGENT_MATRIX, findTarget, parseAgentsOption } from "../integrate/matrix.js";
import { installAntigravity, installTarget, allowlistText } from "../integrate/install.js";

export interface InitOptions {
  agents?: string;
}

// `scopecairn init` (AI-1): indexing awal + inti (AGENTS.md, Skill,
// Workflow) + matriks agent yang diminta/terdeteksi. Idempoten via marker.
export function cmdInit(repoRoot: string, opts: InitOptions = {}): void {
  console.log("ScopeCairn");
  console.log("✓ Repository detected");

  const stats = scanRepository(repoRoot);
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

function withCore(ids: string[]) {
  const out = [];
  for (const id of ids) {
    const t = findTarget(id);
    if (!t) {
      console.log(`! Unknown agent "${id}" (pilihan: ${AGENT_MATRIX.map((x) => x.id).join(", ")}, all)`);
      continue;
    }
    out.push(t);
  }
  if (!out.includes(AGENT_MATRIX[0])) out.unshift(AGENT_MATRIX[0]);
  return out;
}

function withDetected(repoRoot: string) {
  const targets = [AGENT_MATRIX[0]];
  for (const t of AGENT_MATRIX.slice(1)) {
    if (fs.existsSync(path.join(repoRoot, t.presentMarker))) targets.push(t);
  }
  return targets;
}
