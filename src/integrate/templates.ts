// Three-layer auto-invocation template (PRD §8.3). `{prefix}` is populated with
// `scopecairn` or `npx scopecairn` by init so it is identical across all layers
// + allowlist (AI-9).

export const MARKER = "<!-- scopecairn:managed -->";
function ruleBody(prefix: string): string {
  return `# ScopeCairn — Automated Engineering Protocol

## 1. Discipline (Anti-Slop & Laziness Protocol)
- **Minimal Diff**: Smallest change that solves the problem; bias to deletion; no unrequested abstractions or narrative step comments.
- **Boundaries & History**: Validate at I/O/CLI boundaries; keep core logic pure; check git blame before deleting unusual edge-case guards.

## 2. Context Retrieval & Status Cue
- **First line of EVERY response**:
  - Called context: \`> 🧭 [ScopeCairn: context "<query>" → N files in scope]\`
  - Skipped context: \`> 🧭 [ScopeCairn: scope known (<reason>), context skipped]\`
  - Checked impact / verified: \`> 🧭 [ScopeCairn: impact <path> checked]\` / \`> 🧭 [ScopeCairn: verify passed within scope]\`
- **Cold start**: If \`.scopecairn/scopecairn.db\` is missing, run \`${prefix} init\`. At the start of a session, run \`${prefix} session load\` to restore previous working state and git drift.
- **Run \`${prefix} context "<2-4 technical keywords>"\` ONLY IF** target files/symbols are unknown or locking edit scope. If results are empty/off-target, run \`${prefix} map [dir]\` then \`${prefix} context --anchor <path> "<query>"\`.
- **SKIP \`${prefix} context\` IF**: (1) user named the target file/symbol, (2) prompt is Q&A/architecture/review, or (3) scope is already known in this session.
- **Retrieval Options**: Use \`${prefix} context --explain\` for score breakdown (wSeed*seed, prox, cent, recency, cochange, ppr, pr), \`${prefix} context --format brief\` for 1-line-per-file human copy, \`${prefix} context --format table|tree|mermaid\` for tables/trees/call-paths.

## 3. Execution & Verification
- **Scope**: Edit only Required/Optional files; never touch Protected without approval. If >2 files change, run \`${prefix} context --escalate "<query>"\`.
- **Reuse Check**: Before creating a new function or class, run \`${prefix} reuse "<description or signature>"\` and reuse/extend existing symbols when matched.
- **Shared Symbols**: Run \`${prefix} impact <path>\`, state 1 safety fact, and prove it via \`${prefix} impact <path> --run-tests\`.
- **Anti-Looping**: 2 failed fixes on the same test → stop and test the root-cause premise independently before a 3rd edit.
- **Excerpts**: Prefer \`${prefix} read symbol <name>\` or line-ranged reads from \`context\` over full-file reads. Multi-symbol: \`${prefix} read symbol a b c\` with \`--full\`/\`--with-callers\`.
- **Scan Fast Path**: Run \`${prefix} scan --changed-only\` for incremental git-aware rescan; \`${prefix} scan --lsp\` only when LSP (tsserver/gopls/pyright) is available.
- **PR Risk**: Before merge, run \`${prefix} verify --pr-risk --sarif --base origin/main\` for aggregate HIGH/MED/LOW risk + SARIF output. \`--pr-risk --json\` includes full report.
- **Dependencies**: Run \`${prefix} deps\` (offline) to check unused/outdated from manifests (package.json/pyproject.toml/go.mod/Cargo.toml).
- **Before Done**: Self-review edge/async/OS cases, prove with tests (never weaken tests by removing assertions, adding \`.skip\`, or loosening matchers), then run \`${prefix} scan\`, \`${prefix} dead\`, \`${prefix} verify --task "<query>" --strict --test-gate\`, and \`${prefix} session save --working "<summary>" --decisions "<decisions>" --next "<next>" --blockers "<blockers>" --files "<files>"\`. Never bypass git pre-commit hooks with \`--no-verify\`; teams should also enforce \`${prefix} verify --test-gate --base origin/main\` in CI. Coverage: per-symbol coverage is stored (see testGate); retrieval weights tuned via \`${prefix} benchmark --tune\` (nDCG/MRR).
- **Decisions**: Record settled architectural choices via \`${prefix} decide "<choice> because <why>"\` — stored with evidence and included in all future contexts.
- **Coverage**: Supported languages: TS/JS/Python/Java/Go/Rust/PHP/C#/C/C++/Ruby/HTML/Vue/Kotlin/Dart/Shell/SQL/GraphQL/Proto. Frameworks: Prisma/Drizzle/SQLAlchemy/Next.js/Express/FastAPI/NestJS/Django/Vue/Fastify/Koa/Hono/Rails/Laravel/Spring/Go.
`;
}

// Claude skill (project skill + plugin skill): frontmatter bounded by Agent Skills spec for portability.
export function claudeSkillMd(prefix: string): string {
  return `---
name: scopecairn
description: ScopeCairn codebase context + scope + engineering rigor. Use for coding tasks
  (feature, bugfix, refactor) when target files are unknown or to enforce scope,
  and when the user says "scopecairn", asks for a repo overview, or asks
  to set up ScopeCairn.
allowed-tools: Bash
---

${ruleBody(prefix)}`;
}

// Generic rule for other merge files (copilot, etc).
export function genericRuleMd(prefix: string): string {
  return `${MARKER}\n${ruleBody(prefix)}`;
}

// Cursor uses .mdc frontmatter so it is always applied.
export function cursorRuleMdc(prefix: string): string {
  return `---
description: ScopeCairn codebase rules — call scopecairn context when target files are unknown
alwaysApply: true
---

${MARKER}
${ruleBody(prefix)}`;
}

export function skillMd(prefix: string): string {
  return `---
name: scopecairn
description: ScopeCairn codebase context + scope + engineering rigor. Use for coding tasks when target files are unknown or to enforce verification scope.
---

${ruleBody(prefix)}`;
}

export function workflowMd(prefix: string): string {
  return `# /scopecairn

Manual shortcut if the agent forgets to run the automated ScopeCairn protocol.

Automated Principles:
- Laziness Protocol (minimal diff, no slop, never add unnecessary abstraction layers).
- Blast Radius: Shared symbols require impact + safety fact + proof via tests.
- Anti-Looping: 2x failure on the same test → stop and attack underlying premises independently before a 3rd try.
- Prove It Works: Always prove fixes/features with real tests before declaring completion.
- Status Cue: Start response with a 1-line scope indicator, e.g. \`> 🧭 [ScopeCairn: ...]\`.

Workflow Steps:
1. At the start of a session, run \`${prefix} session load\` to inspect previous state and commits/files changed since the last save.
2. If user prompt is long/complex, extract 2–4 technical keywords as context arguments.
3. Run \`${prefix} context "<technical keywords>"\` (if target files are unknown or to lock scope). For score debugging, add \`--explain\`; for human copy, add \`--format brief|table|tree|mermaid\`; for fast rescan after a small change, prefer \`scan --changed-only\`.
4. Follow Relevant Files and Task Scope (Required & Optional; never touch Protected without approval).
5. Before creating a new function or class, run \`${prefix} reuse "<description or signature>"\`.
6. Need to check impact of changes? \`${prefix} impact <path> --run-tests\`.
7. Need symbol source code? \`${prefix} read symbol <name>\` (multi: \`${prefix} read symbol a b c --full --with-callers\`).
8. Check dependencies? \`${prefix} deps\` (offline, from manifests).
9. Before PR/merge? \`${prefix} verify --pr-risk --sarif --base origin/main\`.
10. Architectural decision settled? \`${prefix} decide "<choice> because <why>"\`.
11. Before declaring completion:
   - Adversarial self-review: check null/undefined/edge-cases, async race conditions, OS compatibility.
   - Prove changes with real tests.
   - Run \`${prefix} scan\`, \`${prefix} dead\`, then \`${prefix} verify --task "<technical keywords>" --strict\`
     — ensuring no dead code was introduced and modified files did not leak outside scope.
   - Save session state via \`${prefix} session save --working "<summary>" --decisions "<decisions>" --next "<next>" --blockers "<blockers>" --files "<files>"\`.
Prereq (CI): \`scan --lsp\` only when LSP exists; \`benchmark --tune\` reports nDCG/MRR for weight calibration.
`;
}

// OpenCode custom command (docs/commands): \`.opencode/commands/*.md\`
// with frontmatter + $ARGUMENTS. AGENTS.md is still read by OpenCode (docs/rules).
export function opencodeCommandMd(prefix: string): string {
  return `---
description: ScopeCairn codebase context + scope + engineering rigor for a task
---

Run \`${prefix} session load\` at the start of the session, then run \`${prefix} context "$ARGUMENTS"\` with the bash tool (extract 2-4 technical keywords if query is complex), then:

1. Always show a 1-line status cue at the start of your response, e.g. \`> 🧭 [ScopeCairn: context "$ARGUMENTS" → N files]\` (or explain if skipped).
2. Use Relevant Files as the starting point — do not explore from zero.
3. Change only Required and Optional files; Protected needs user approval.
4. Before creating a new function or class, run \`${prefix} reuse "<description or signature>"\`.
5. If shared symbols change, run \`${prefix} impact <path>\`, formulate one safety fact, and verify with tests.
6. If bug fix fails 2x on the same test, stop and attack the premise independently before attempting a 3rd time.
7. Need a function body? Use \`${prefix} read symbol <name> [more...] --full --with-callers\`, not full reads.
8. Before finishing: perform adversarial self-review, ensure real tests pass, run \`${prefix} scan\` (or \`scan --changed-only\` for speed), run \`${prefix} dead\`, run \`${prefix} verify --task "$ARGUMENTS" --strict\` (or \`verify --pr-risk --sarif --base origin/main\` before PR), run \`${prefix} deps\` for dependency health, and run \`${prefix} session save\`.
9. Settled an architectural decision? Record it once: \`${prefix} decide "<choice> because <why>"\`.
<!-- scopecairn:managed -->
`;
}

// OpenCode permission guide snippet (docs/permissions). Printed only, not auto-written:
// opencode.json is JSONC (allows comments) and user-owned — auto-merge risks corruption.
export function opencodePermissionGuide(prefix: string): string {
  const rules = ALLOWLIST_COMMANDS.map(
    (c) => `      "${prefix} ${c} *": "allow"`
  ).join(",\n");
  return (
    `To allow the commands above to run without approval prompts, merge this into opencode.json\n` +
    `(project root or ~/.config/opencode/opencode.json):\n\n` +
    `{\n  "permission": {\n    "bash": {\n${rules}\n    }\n  }\n}\n\n` +
    `Note: ScopeCairn does not modify your opencode.json automatically.`
  );
}

// Dedicated knowledge agent skill (explain/summarize/audit — read-only).
// Single shared body across agents to keep copies synchronized; only "claude"
// includes allowed-tools (Claude Agent Skills specific grant).
export function knowledgeSkillMd(
  prefix: string,
  variant: "portable" | "claude" = "portable"
): string {
  const tools = variant === "claude" ? "allowed-tools: Bash\n" : "";
  return `---
name: scopecairn-knowledge
description: ScopeCairn cold-start map + context extraction for knowledge tasks —
  explain, summarize, document, audit, "how does X work", "why is it like this",
  architecture overview, ownership or bus factor. Read-only — never for code changes.
${tools}---

# ScopeCairn — Knowledge Mode (ReAct)

Reasoning loop: Thought → Action → Observe, max 3 iterations. All Actions are
read-only to the source code; ScopeCairn only writes to \`.scopecairn/\`.

Iteration 0 — Cold start (skip any missing artifacts):
Thought: what is already known about this repo without running any queries?
Action: read in order:
- \`.scopecairn/GRAPH.md\` — budgeted graph map: modules, most-used symbols,
  PageRank hotspots, cycles, routes, models, protected files.
- \`.scopecairn/ARCHAEOLOGY.md\` — ownership / bus factor / churn from local git log
  (write-once snapshot; delete the file to regenerate).
- \`.scopecairn/decisions.md\` — recorded architectural decisions (logged by
  user/agent via \`${prefix} decide\`), if any.
Observe freshness: GRAPH.md contains the line
\`> Freshness: scanned <ISO> · HEAD <sha>\` (if missing — e.g. legacy index —
skip this check). If present, compare <sha> with \`git rev-parse --short HEAD\`;
if different, note that the map may be outdated and rely on live commands for
modified areas. Cold start = orientation, not the answer.

Iteration 1 — Scope:
Thought: what is actually being asked?
Action: \`${prefix} context --knowledge "<user question>" --json\`
Observe: check \`high\`, \`medium\`, \`symbols[0].score\`, \`analogs\`, \`empty\`.
- Both \`high\` AND \`medium\` empty / all scores <0.15 → reformulate once (domain
  aliases from \`.scopecairn/glossary.yml\`, split into 2 sub-questions), then
  continue from cold start — do not halt.
- \`high\` empty but \`medium\` has entries → normal for SIMPLE tasks; proceed.
- \`analogs\` = commits touching the same area: evidence of "why". Quote
  \`shortSha + subject\`.
- Architectural decisions: attached at the end of markdown output
  (\`## Architectural Decisions\`); for \`--json\`, read \`.scopecairn/decisions.md\`
  directly (the JSON envelope omits it).

Iteration 2 — Expand:
Thought: which symbols need relationship tracing?
Action (choose as needed, always \`--json\`):
- Module relations: \`${prefix} graph <symbol> --json\` (add \`--budget <n>\` for large monorepos)
- Blast radius / impact: \`${prefix} impact <path> --json\`
- Flow A→B: \`${prefix} graph <from> --to <to> --json\`
- Dependencies: \`${prefix} deps --json\` (offline manifest health)
Observe: connect hops via \`edges[].rel\` (\`graph\`) or \`hops[].rel\`
(\`graph --to\`) — relationships CALLS/IMPORTS/QUERIES/ROUTES_TO. Ranking is
5-signal + PageRank/PPR (\`wSeed/wProximity/wCentrality/wRecency/wCochange\`
plus optional PPR/PR); use \`context --explain --format brief\` to inspect.
Coverage: languages TS/JS/Python/Java/Go/Rust/PHP/C#/C/C++/Ruby/HTML/Vue/
Kotlin/Dart/Shell/SQL/GraphQL/Proto; frameworks Prisma/Drizzle/SQLAlchemy/
Next.js/Express/FastAPI/NestJS/Django/Vue/Fastify/Koa/Hono/Rails/Laravel/
Spring/Go.
Stop when the chain answers "why / how".

Iteration 3 — Ground:
Thought: what is the historical / source evidence?
Action:
- \`${prefix} history "<question>" --json\` for decisions + co-changes
  (\`empty: true\` = no analogs — do not force).
- \`${prefix} read symbol <name> --json\` for excerpts (do not read full files).
Observe: quote \`shortSha + subject\` and \`file:range\` as evidence.

Stop rules: stop when the answer is complete, or 3 iterations reached, or \`high\`
is stable across iterations. Answer structure: direct answer first, followed by
evidence (\`file:line\`, \`shortSha + subject\`), then open questions. Every claim
requires evidence from the commands above — cold start artifacts provide
orientation, not per-task proof. Never write or modify files — only read,
summarize, and explain.
`;
}

// Safe commands for allowlist (read-only to source code, only writes to \`.scopecairn/\`).
// \`history\` is included even though it is a hidden alias — the knowledge skill uses it for "why" evidence.
export const ALLOWLIST_COMMANDS = [
  "context",
  "reuse",
  "dead",
  "session",
  "impact",
  "read",
  "graph",
  "history",
  "status",
  "verify",
  "deps",
  "benchmark",
  "doctor",
  "map",
  "diff",
  "archcheck",
  "export",
] as const;

// \`decide\` is intentionally NOT in the allowlist: its prose is injected into every
// subsequent \`context\` prompt, so agents must never write to it without per-call user approval.
export const MANUAL_ONLY_COMMANDS = ["init", "scan", "decide"] as const;

export function allowlistGuide(prefix: string): string {
  const lines = ALLOWLIST_COMMANDS.map((c) => `  ${prefix} ${c}`);
  return (
    `To allow the agent to run ScopeCairn without approval prompts,\n` +
    `add the following entries to your Antigravity Terminal Allow List\n` +
    `(Settings → Advanced Settings → Terminal):\n\n` +
    lines.join("\n") +
    `\n\nNote: ScopeCairn does not modify your IDE settings automatically.\n` +
    `\`decide\` is intentionally omitted: its content is injected into every subsequent\n` +
    `context call, so it should always require explicit user approval.`
  );
}
