import type { Command } from "commander";
import { AGENT_MATRIX } from "../integrate/matrix.js";
import {
  agentIds,
  allowlistText,
  installAntigravity,
  installTarget,
  resolveAgent,
  uninstallAntigravity,
  uninstallTarget,
} from "../integrate/install.js";
import { detectPrefix } from "../integrate/detect.js";

// Perintah per-agent: `scopecairn <agent> install|uninstall` + `scopecairn agents list`.
// Antigravity = Skill + Workflow + panduan allowlist; lainnya = file matriks.
export function registerAgentCommands(program: Command, repoRoot: () => string): void {
  const list = program.command("agents").description("List supported agent installers");
  list
    .command("list")
    .description("Show agent ids")
    .action(() => {
      console.log(agentIds().join("\n"));
    });

  const anti = program.command("antigravity").description("Antigravity IDE integration");
  anti
    .command("install")
    .description("Install Skill + Workflow, print allowlist guide")
    .action(() => {
      const root = repoRoot();
      const prefix = detectPrefix(root);
      for (const line of installAntigravity(root, prefix)) console.log(`✓ ${line}`);
      console.log("");
      console.log(allowlistText(root));
    });
  anti
    .command("uninstall")
    .description("Remove Skill + Workflow")
    .action(() => {
      for (const line of uninstallAntigravity(repoRoot())) console.log(`✓ ${line}`);
    });

  for (const t of AGENT_MATRIX) {
    if (t.id === "agents") continue; // inti milik init
    const cmd = program.command(t.id).description(`${t.label} integration`);
    cmd
      .command("install")
      .description(`Write ${t.rel}`)
      .action(() => {
        const root = repoRoot();
        const r = installTarget(root, t, detectPrefix(root));
        console.log(`✓ ${t.label}: ${r.rel} (${r.how})`);
      });
    cmd
      .command("uninstall")
      .description(`Remove ScopeCairn block from ${t.rel}`)
      .action(() => {
        const r = uninstallTarget(repoRoot(), t);
        console.log(`✓ ${t.label}: ${r.rel} (${r.how})`);
      });
  }
}
