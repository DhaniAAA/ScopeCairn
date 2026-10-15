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
import { cmdHistory } from "./commands/history.js";
import { cmdImpact } from "./commands/impact.js";
import { cmdInit } from "./commands/init.js";
import { cmdBenchmark } from "./commands/benchmark.js";
import { cmdDashboard } from "./commands/dashboard.js";
import { cmdTestSelect } from "./commands/testselect.js";
import { cmdVerify } from "./commands/verify.js";
import { cmdDiff } from "./commands/diff.js";
import { cmdArchCheck } from "./commands/archcheck.js";
import { cmdWatch } from "./commands/watch.js";
import { cmdUpdate } from "./commands/update.js";
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
6 Core Commands:
  $ scopecairn scan                       index repository (--rebuild, --clean, --watch)
  $ scopecairn context "add login"        AI agent context + scope for a task
  $ scopecairn impact src/indexer.ts      change blast radius & test selection (--run-tests)
  $ scopecairn graph buildContext         inspect graph relations, path (--to), export (--export)
  $ scopecairn verify                     safety guard: protected, scope, cycles (--diff, --arch)
  $ scopecairn status                     health & index status (--doctor, --html)

Helper & Setup Commands:
  $ scopecairn init                      index repo + setup agent integration
  $ scopecairn read symbol indexFileSymbols symbol-level source excerpt

Previous standalone commands (rebuild, clean, watch, doctor, dashboard,
test-select, path, export, diff, arch-check, history) still work as hidden
aliases mapped into the commands above. benchmark (dev-only) and update
(deprecated, use npm) are also hidden from this list.

Agent commands (context, impact, read, graph, status, verify) are
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

// ==========================================
// 1. SCAN (Index Lifecycle: normal, rebuild, clean, watch)
// ==========================================
program
  .command("scan")
  .description("Index repository (--rebuild, --clean, --watch)")
  .option("--rebuild", "rebuild index from scratch (recover from corrupt index)")
  .option("--clean", "remove local index directory (.scopecairn)")
  .option("--watch", "watch repository files and auto-refresh index in background")
  .option("--debounce <ms>", "debounce time in milliseconds for watch mode (default 300)", parseInt)
  .action((opts: { rebuild?: boolean; clean?: boolean; watch?: boolean; debounce?: number }) =>
    cmdScan(repoRoot(), opts)
  );

// ==========================================
// 2. CONTEXT (AI Agent Task Intelligence)
// ==========================================
program
  .command("context <task>")
  .description("Main entry point: auto-refresh + classify + relevant context + scope")
  .option("--escalate", "force full COMPLEX context")
  .option("--no-refresh", "skip incremental refresh (debugging/benchmark)")
  .option("--mode <mode>", "agent mode: NORMAL|FAST|SAFE|AUDIT", "NORMAL")
  .option("--max-tokens <n>", "potong konteks agar estimasi muat N token (≈ char/4)", parseInt)
  .option("--no-history", "lewati bagian Analogi riwayat")
  .option("--with-diff", "tambahkan ringkasan diff pada Analogi riwayat")
  .option("--no-rules", "lewati bagian Project Rules (AGENTS.md)")
  .option("--knowledge", "explain mode untuk knowledge agent: tanpa Scope/Guard coding")
  .option("--json", "output results as JSON")
  .action((task: string, opts: { escalate?: boolean; noRefresh?: boolean; mode?: "NORMAL" | "FAST" | "SAFE" | "AUDIT"; maxTokens?: number; noHistory?: boolean; withDiff?: boolean; noRules?: boolean; knowledge?: boolean; json?: boolean }) =>
    cmdContext(repoRoot(), task, opts)
  );

// ==========================================
// 3. IMPACT (Blast Radius & Test Selection)
// ==========================================
program
  .command("impact <target>")
  .description("Change impact analysis: direct, indirect, tests, UI, and APIs (--run-tests, --tests)")
  .option("--run-tests", "execute the affected test runner command directly")
  .option("--tests", "only list test files affected by the change target")
  .option("--no-refresh", "skip incremental refresh (debugging/benchmark)")
  .option("--json", "output results as JSON")
  .option("--repos [list]", "blast radius lintas repo: daftar path koma (tanpa nilai = baca .scopecairn/repos.yml)")
  .action((target: string, opts: { noRefresh?: boolean; json?: boolean; repos?: string | boolean; runTests?: boolean; tests?: boolean }) =>
    cmdImpact(repoRoot(), target, { ...opts, testsOnly: opts.tests })
  );

// ==========================================
// 4. GRAPH (Inspection, Shortest Path, Export)
// ==========================================
program
  .command("graph [symbol]")
  .description("Show relations of a symbol, shortest call path (--to), or export (--export)")
  .option("--to <target>", "show shortest call/dependency path to target symbol")
  .option("--export <fmt>", "export codebase graph (mermaid|graphml|dot|json)")
  .option("--out <path>", "output file for export")
  .option("--json", "output results as JSON")
  .action((symbol: string | undefined, opts: { json?: boolean; to?: string; export?: string; out?: string }) =>
    cmdGraph(repoRoot(), symbol, opts)
  );

// ==========================================
// 5. VERIFY (Safety Guard, Diff, Architecture)
// ==========================================
program
  .command("verify")
  .description("Pre-commit guard: check protected files, task scope, cycles (--diff, --arch)")
  .option("--diff", "structural symbol-level diff of working tree vs HEAD")
  .option("--arch", "check architectural layer rules and import boundaries")
  .option("--init", "generate initial .scopecairn/arch.json configuration template (with --arch)")
  .option("--task <task>", "task description to check scope creep against")
  .option("--strict", "fail if any changes fall outside task scope")
  .option("--json", "output results as JSON")
  .option("--no-refresh", "skip index auto-refresh")
  .action((opts: { task?: string; strict?: boolean; json?: boolean; noRefresh?: boolean; diff?: boolean; arch?: boolean; init?: boolean }) =>
    cmdVerify(repoRoot(), opts)
  );

// ==========================================
// 6. STATUS (Health Check & Diagnostics)
// ==========================================
program
  .command("status")
  .description("Show index status, health diagnostics (--doctor), and dashboard (--html)")
  .option("--doctor", "check integration and adapter health")
  .option("--verbose", "print adapter/graph errors to stderr as well (with --doctor)")
  .option("--html", "generate a local HTML dashboard into .scopecairn/dashboard.html")
  .option("--out <path>", "output file for dashboard HTML")
  .action((opts: { doctor?: boolean; verbose?: boolean; html?: boolean; out?: string }) =>
    cmdStatus(repoRoot(), opts)
  );

// ==========================================
// Helper & Setup Commands
// ==========================================
program
  .command("init [path]")
  .description("Initial indexing + Skill, Workflow, agent skills (never touches AGENTS.md)")
  .option("--agents <list>", "agent targets: comma list from claude,cursor,windsurf,copilot,kiro,opencode, or 'all'")
  .action((targetPath: string | undefined, opts: { agents?: string }) =>
    cmdInit(resolveRoot(targetPath), opts)
  );

program
  .command("read")
  .argument("<kind>", "what to read (symbol)")
  .argument("<name>", "symbol name")
  .description("Read a symbol's source excerpt (not the whole file)")
  .option("--json", "output results as JSON")
  .action((kind: string, name: string, opts: { json?: boolean }) => cmdRead(repoRoot(), kind, name, opts));

program
  .command("benchmark", { hidden: true })
  .description("Retrieval recall, irrelevant ratio, context reduction + weight tuning")
  .option("--tune", "grid search bobot FR-05")
  .option("--no-refresh", "skip incremental refresh (debugging/benchmark)")
  .action((opts: { tune?: boolean; noRefresh?: boolean }) =>
    cmdBenchmark(repoRoot(), opts)
  );

program
  .command("update", { hidden: true })
  .description("[Deprecated: gunakan `npm i -g scopecairn@latest`] Update scopecairn dari npm registry")
  .option("--check", "hanya cek versi terbaru tanpa menginstall")
  .action((opts: { check?: boolean }) => cmdUpdate(opts));

// ==========================================
// Hidden Aliases (tetap berfungsi, tidak tampil di --help)
// ==========================================
program
  .command("rebuild", { hidden: true })
  .description("[Alias: `scopecairn scan --rebuild`] Rebuild index from scratch")
  .action(() => cmdScan(repoRoot(), { rebuild: true }));

program
  .command("clean", { hidden: true })
  .description("[Alias: `scopecairn scan --clean`] Remove local index (.scopecairn)")
  .action(() => cmdScan(repoRoot(), { clean: true }));

program
  .command("watch", { hidden: true })
  .description("[Alias: `scopecairn scan --watch`] Watch files and refresh index automatically")
  .option("--debounce <ms>", "debounce time in milliseconds (default 300)", parseInt)
  .action((opts: { debounce?: number }) => cmdScan(repoRoot(), { watch: true, debounce: opts.debounce }));

program
  .command("doctor", { hidden: true })
  .description("[Alias: `scopecairn status --doctor`] Check integration health")
  .option("--verbose", "print adapter/graph errors to stderr as well")
  .action((opts: { verbose?: boolean }) => cmdStatus(repoRoot(), { doctor: true, verbose: opts.verbose }));

program
  .command("dashboard", { hidden: true })
  .description("[Alias: `scopecairn status --html`] Generate local HTML dashboard")
  .option("--out <path>", "output file")
  .action((opts: { out?: string }) => cmdStatus(repoRoot(), { html: true, out: opts.out }));

program
  .command("test-select <target>", { hidden: true })
  .description("[Alias: `scopecairn impact <target> --run-tests`] List and run affected tests")
  .option("--run", "execute the affected test runner command directly")
  .option("--json", "output results as JSON")
  .action((target: string, opts: { run?: boolean; json?: boolean }) => cmdTestSelect(repoRoot(), target, opts));

program
  .command("path <from> <to>", { hidden: true })
  .description("[Alias: `scopecairn graph <from> --to <to>`] Shortest call path between symbols")
  .option("--json", "output results as JSON")
  .action((from: string, to: string, opts: { json?: boolean }) => cmdPath(repoRoot(), from, to, opts));

program
  .command("export", { hidden: true })
  .description("[Alias: `scopecairn graph --export <fmt>`] Export codebase graph")
  .option("--format <fmt>", "export format", "mermaid")
  .option("--out <path>", "output file (default .scopecairn/graph.<ext>)")
  .action((opts: { format: string; out?: string }) => cmdExport(repoRoot(), opts.format, opts.out));

program
  .command("diff", { hidden: true })
  .description("[Alias: `scopecairn verify --diff`] Structural symbol-level diff vs HEAD")
  .option("--json", "output results as JSON")
  .action((opts: { json?: boolean }) => cmdDiff(repoRoot(), opts));

program
  .command("arch-check", { hidden: true })
  .description("[Alias: `scopecairn verify --arch`] Check architectural layer rules")
  .option("--init", "generate initial .scopecairn/arch.json configuration template")
  .option("--json", "output results as JSON")
  .action((opts: { init?: boolean; json?: boolean }) => cmdArchCheck(repoRoot(), opts));

program
  .command("history <task>", { hidden: true })
  .description("[Alias: `scopecairn context \"<task>\"`] Find analog commits for task")
  .option("--limit <n>", "jumlah analog (default 3, maks 10)", parseInt)
  .option("--json", "output results as JSON")
  .option("--no-refresh", "skip incremental refresh (debugging/benchmark)")
  .option("--with-diff", "tambahkan ringkasan diff per analog")
  .action((task: string, opts: { limit?: number; json?: boolean; noRefresh?: boolean; withDiff?: boolean }) =>
    cmdHistory(repoRoot(), task, opts)
  );

registerAgentCommands(program, repoRoot);

program.parseAsync(process.argv);
