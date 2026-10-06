import { Command } from "commander";
import fs from "node:fs";
import path from "node:path";
import { cmdScan } from "./commands/scan.js";
import { cmdStatus } from "./commands/status.js";
import { cmdRebuild } from "./commands/rebuild.js";
import { cmdDoctor } from "./commands/doctor.js";
import { cmdGraph } from "./commands/graph.js";
import { cmdPath } from "./commands/path.js";
import { cmdExport } from "./commands/export.js";
import { cmdRead } from "./commands/read.js";
import { cmdContext } from "./commands/context.js";
import { cmdImpact } from "./commands/impact.js";
import { cmdInit } from "./commands/init.js";
import { cmdBenchmark } from "./commands/benchmark.js";
import { cmdDashboard } from "./commands/dashboard.js";
import { cmdTestSelect } from "./commands/testselect.js";
import { registerAgentCommands } from "./commands/agents.js";
import pkg from "../package.json" with { type: "json" };

const program = new Command();
program
  .name("scopecairn")
  .description("ScopeCairn — local-first codebase intelligence layer")
  .version((pkg as { version: string }).version)
  .addHelpText(
    "after",
    `
Examples:
  $ scopecairn init                      index repo + setup agent integration
  $ scopecairn init ./myapp --agents all  setup another directory, all agents
  $ scopecairn context "add login"        relevant context + scope for a task
  $ scopecairn context ./                 repository orientation map
  $ scopecairn impact src/auth/login.ts   change impact analysis
  $ scopecairn read symbol approveRequest  symbol-level source excerpt
  $ scopecairn path handleLogin dbQuery    shortest call path between symbols
  $ scopecairn export --format mermaid     export graph (mermaid|graphml|dot|json)
  $ scopecairn doctor                     health + integration check

Agent commands (context, impact, read, graph, status, doctor) are
read-only toward source and only write to .scopecairn/ — safe to allowlist.
`
  );

function repoRoot(): string {
  return path.resolve(process.cwd());
}

/** Resolve repo root dari argumen path opsional (`./`, `../foo`, absolut). */
export function resolveRoot(given?: string): string {
  if (!given) return repoRoot();
  return path.resolve(process.cwd(), given);
}

program
  .command("scan")
  .description("Index repository (files + symbols + relations)")
  .action(() => cmdScan(repoRoot()));

program
  .command("status")
  .description("Show index status")
  .action(() => cmdStatus(repoRoot()));

program
  .command("rebuild")
  .description("Rebuild index from scratch (recover from corrupt index)")
  .action(() => cmdRebuild(repoRoot()));

program
  .command("doctor")
  .description("Check integration health")
  .option("--verbose", "print adapter/graph errors to stderr as well")
  .action(async (opts: { verbose?: boolean }) => {
    await cmdDoctor(repoRoot(), { verbose: opts.verbose });
  });

program
  .command("clean")
  .description("Remove local index (.scopecairn) — forces full rescan")
  .action(() => {
    const dir = path.join(repoRoot(), ".scopecairn");
    fs.rmSync(dir, { recursive: true, force: true });
    console.log("Removed .scopecairn/. Run `scopecairn scan` to rebuild.");
  });

program
  .command("dashboard")
  .description("Generate a local HTML dashboard into .scopecairn/dashboard.html")
  .option("--out <path>", "output file (default .scopecairn/dashboard.html)")
  .action((opts: { out?: string }) => cmdDashboard(repoRoot(), opts));

program
  .command("test-select <target>")
  .description("List test files affected by a change target (file/symbol)")
  .action((target: string) => cmdTestSelect(repoRoot(), target));

program
  .command("graph <symbol>")
  .description("Show relations of a symbol")
  .action((symbol: string) => cmdGraph(repoRoot(), symbol));

program
  .command("path <from> <to>")
  .description("Show shortest call/dependency path between two symbols")
  .action((from: string, to: string) => cmdPath(repoRoot(), from, to));

program
  .command("export")
  .description("Export codebase graph (mermaid|graphml|dot|json)")
  .option("--format <fmt>", "export format", "mermaid")
  .option("--out <path>", "output file (default .scopecairn/graph.<ext>)")
  .action((opts: { format: string; out?: string }) => cmdExport(repoRoot(), opts.format, opts.out));

program
  .command("read")
  .argument("<kind>", "what to read (symbol)")
  .argument("<name>", "symbol name")
  .description("Read a symbol's source excerpt (not the whole file)")
  .action((kind: string, name: string) => cmdRead(repoRoot(), kind, name));

program
  .command("context <task>")
  .description("Main entry point: auto-refresh + classify + relevant context + scope")
  .option("--escalate", "force full COMPLEX context")
  .option("--no-refresh", "skip incremental refresh (debugging/benchmark)")
  .option("--mode <mode>", "agent mode: NORMAL|FAST|SAFE|AUDIT", "NORMAL")
  .action((task: string, opts: { escalate?: boolean; noRefresh?: boolean; mode?: "NORMAL" | "FAST" | "SAFE" | "AUDIT" }) =>
    cmdContext(repoRoot(), task, opts)
  );

program
  .command("impact <target>")
  .description("Change impact analysis: file, symbol, function, or class")
  .option("--no-refresh", "skip incremental refresh (debugging/benchmark)")
  .action((target: string, opts: { noRefresh?: boolean }) =>
    cmdImpact(repoRoot(), target, opts)
  );

program
  .command("init [path]")
  .description("Initial indexing + Skill, Workflow, agent skills (never touches AGENTS.md)")
  .option("--agents <list>", "agent targets: comma list from claude,cursor,windsurf,copilot,kiro,opencode, or 'all'")
  .action((targetPath: string | undefined, opts: { agents?: string }) =>
    cmdInit(resolveRoot(targetPath), opts)
  );

program
  .command("benchmark")
  .description("Retrieval recall, irrelevant ratio, context reduction + weight tuning")
  .option("--tune", "grid search bobot FR-05")
  .option("--no-refresh", "skip incremental refresh (debugging/benchmark)")
  .action((opts: { tune?: boolean; noRefresh?: boolean }) =>
    cmdBenchmark(repoRoot(), opts)
  );

registerAgentCommands(program, repoRoot);

program.parseAsync(process.argv);
