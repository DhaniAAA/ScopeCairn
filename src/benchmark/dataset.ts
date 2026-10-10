// Dataset benchmark awal (PRD §18.2): 12 task nyata atas repo sendiri
// dengan ground truth file yang relevan. Skala kecil untuk iterasi cepat;
// diperluas ke 10–50 task lintas repo sebelum klaim final.

export interface BenchmarkTask {
  task: string;
  expected: string[];
}

export const BENCHMARK_TASKS: BenchmarkTask[] = [
  {
    task: "Add ranking weight configuration",
    expected: ["src/retrieval/retrieve.ts", "src/retrieval/config.ts"],
  },
  {
    task: "Change impact analysis for a file",
    expected: ["src/commands/impact.ts", "src/graph.ts"],
  },
  {
    task: "Task scope required optional protected files",
    expected: ["src/scope/scope.ts", "src/scope/protected.ts"],
  },
  {
    task: "Generate AGENTS.md skill workflow on init",
    expected: ["src/commands/init.ts", "src/integrate/templates.ts"],
  },
  {
    task: "Repository scanner ignore rules",
    expected: ["src/scanner.ts", "src/ignore.ts"],
  },
  {
    task: "Symbol extraction typescript functions classes",
    expected: ["src/extract/typescript.ts", "src/extract/types.ts"],
  },
  {
    task: "Invocation logging compliance rate",
    expected: ["src/invocations.ts", "src/commands/status.ts"],
  },
  {
    task: "Upgrade dependencies in package json",
    expected: ["package.json", "package-lock.json"],
  },
  {
    task: "Read symbol source excerpt",
    expected: ["src/commands/read.ts", "src/graph.ts"],
  },
  {
    task: "Git recency co-change signals ranking",
    expected: ["src/retrieval/git.ts", "src/retrieval/retrieve.ts"],
  },
  {
    task: "Complexity classifier simple versus complex",
    expected: ["src/retrieval/classify.ts", "src/retrieval/contextBuilder.ts"],
  },
  {
    task: "Health check integration files prefix",
    expected: ["src/commands/doctor.ts", "src/integrate/detect.ts"],
  },
  {
    task: "Django routes models registration",
    expected: ["src/adapters/django.ts", "src/adapters/index.ts"],
  },
  {
    task: "Nestjs routes injectables",
    expected: ["src/adapters/nestjs.ts", "src/adapters/index.ts"],
  },
  {
    task: "Watch command file changes",
    expected: ["src/commands/watch.ts", "src/scanner.ts"],
  },
  {
    task: "Architecture check layer rules",
    expected: ["src/commands/archcheck.ts"],
  },
  {
    task: "Diff breaking change detection",
    expected: ["src/commands/diff.ts"],
  },
  {
    task: "Verify protected scope cycles",
    expected: ["src/commands/verify.ts", "src/scope/protected.ts"],
  },
  {
    task: "Visual graph HTML explorer",
    expected: ["src/graph/visual.ts", "src/graph/clusters.ts"],
  },
  {
    task: "Tokenizer stemming plural forms",
    expected: ["src/retrieval/tokenize.ts", "src/retrieval/symbolIndex.ts"],
  },
];
