import fs from "node:fs";
import path from "node:path";
import { scanRepository } from "../scanner.js";
import { detectAgentDir, detectPrefix } from "../integrate/detect.js";
import {
  MARKER,
  skillMd,
  workflowMd,
  allowlistGuide,
} from "../integrate/templates.js";
import {
  AGENT_MATRIX,
  findTarget,
  parseAgentsOption,
  type AgentTarget,
} from "../integrate/matrix.js";

export interface InitOptions {
  agents?: string;
}

// Tulis/merge satu target matriks. Return true bila file berubah.
function writeTarget(repoRoot: string, target: AgentTarget, prefix: string): string {
  const abs = path.join(repoRoot, target.rel);
  const block = target.render(prefix);
  if (target.mode === "new") {
    const existed = fs.existsSync(abs);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, block.endsWith("\n") ? block : block + "\n");
    return existed ? "updated" : "generated";
  }
  if (fs.existsSync(abs)) {
    const cur = fs.readFileSync(abs, "utf8");
    if (cur.includes(MARKER)) {
      const re = new RegExp(`${MARKER}[\\s\\S]*?(?=\\n#[^#]|$)`, "");
      fs.writeFileSync(abs, cur.replace(re, block.trimEnd()).trimEnd() + "\n");
      return "updated";
    }
    fs.writeFileSync(abs, cur.trimEnd() + "\n\n" + block);
    return "extended";
  }
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, block.endsWith("\n") ? block : block + "\n");
  return "generated";
}

// `scopecairn init` (AI-1): indexing awal + generate AGENTS.md, Skill,
// Workflow, dan matriks agent. Idempoten via marker.
export function cmdInit(repoRoot: string, opts: InitOptions = {}): void {
  console.log("ScopeCairn");
  console.log("✓ Repository detected");

  const stats = scanRepository(repoRoot);
  console.log(`✓ ${stats.sourceFiles} source files`);
  if (stats.metaFiles > 0) console.log(`✓ ${stats.metaFiles} config/schema files`);
  console.log(`✓ ${stats.symbols} symbols`);
  console.log(`✓ ${stats.relationships} relationships`);

  const prefix = detectPrefix(repoRoot);
  const agentDir = detectAgentDir(repoRoot);

  // Pilih target: --agents all/list, atau inti + yang setup-nya sudah ada.
  const requested = parseAgentsOption(opts.agents);
  let targets: AgentTarget[];
  if (requested === "all") {
    targets = [...AGENT_MATRIX];
  } else if (requested && requested.length > 0) {
    targets = [];
    for (const id of requested) {
      const t = findTarget(id);
      if (!t) {
        console.log(`! Unknown agent "${id}" (pilihan: ${AGENT_MATRIX.map((x) => x.id).join(", ")}, all)`);
        continue;
      }
      targets.push(t);
    }
    if (!targets.includes(AGENT_MATRIX[0])) targets.unshift(AGENT_MATRIX[0]);
  } else {
    targets = [AGENT_MATRIX[0]]; // AGENTS.md selalu
    for (const t of AGENT_MATRIX.slice(1)) {
      if (fs.existsSync(path.join(repoRoot, t.presentMarker))) targets.push(t);
    }
  }

  for (const t of targets) {
    const how = writeTarget(repoRoot, t, prefix);
    console.log(`✓ ${t.label}: ${t.rel} (${how})`);
  }

  // Skill (AI-2: lokasi mengikuti versi IDE).
  const skillPath = path.join(repoRoot, agentDir, "skills", "scopecairn", "SKILL.md");
  fs.mkdirSync(path.dirname(skillPath), { recursive: true });
  fs.writeFileSync(skillPath, skillMd(prefix));
  console.log(`✓ Skill installed (${path.relative(repoRoot, skillPath)})`);

  // Workflow opsional.
  const wfPath = path.join(repoRoot, "workflows", "scopecairn.md");
  fs.mkdirSync(path.dirname(wfPath), { recursive: true });
  fs.writeFileSync(wfPath, workflowMd(prefix));
  console.log(`✓ Workflow installed (${path.relative(repoRoot, wfPath)})`);

  console.log("Ready.");
  console.log("");
  console.log(allowlistGuide(prefix));
}
