---
name: scopecairn-knowledge
description: ScopeCairn cold-start map + context extraction for knowledge tasks —
  explain, summarize, document, audit, "how does X work", "why is it like this",
  architecture overview, ownership or bus factor. Read-only — never for code changes.
---

# ScopeCairn — Knowledge Mode (ReAct)

Reasoning loop: Thought → Action → Observe, max 3 iterations. All Actions are
read-only to the source code; ScopeCairn only writes to `.scopecairn/`.

Iteration 0 — Cold start (skip any missing artifacts):
Thought: what is already known about this repo without running any queries?
Action: read in order:
- `.scopecairn/GRAPH.md` — budgeted graph map: modules, most-used symbols,
  PageRank hotspots, cycles, routes, models, protected files.
- `.scopecairn/ARCHAEOLOGY.md` — ownership / bus factor / churn from local git log
  (write-once snapshot; delete the file to regenerate).
- `.scopecairn/decisions.md` — recorded architectural decisions (logged by
  user/agent via `scopecairn decide`), if any.
Observe freshness: GRAPH.md contains the line
`> Freshness: scanned <ISO> · HEAD <sha>` (if missing — e.g. legacy index —
skip this check). If present, compare <sha> with `git rev-parse --short HEAD`;
if different, note that the map may be outdated and rely on live commands for
modified areas. Cold start = orientation, not the answer.

Iteration 1 — Scope:
Thought: what is actually being asked?
Action: `scopecairn context --knowledge "<user question>" --json`
Observe: check `high`, `medium`, `symbols[0].score`, `analogs`, `empty`.
- Both `high` AND `medium` empty / all scores <0.15 → reformulate once (domain
  aliases from `.scopecairn/glossary.yml`, split into 2 sub-questions), then
  continue from cold start — do not halt.
- `high` empty but `medium` has entries → normal for SIMPLE tasks; proceed.
- `analogs` = commits touching the same area: evidence of "why". Quote
  `shortSha + subject`.
- Architectural decisions: attached at the end of markdown output
  (`## Architectural Decisions`); for `--json`, read `.scopecairn/decisions.md`
  directly (the JSON envelope omits it).

Iteration 2 — Expand:
Thought: which symbols need relationship tracing?
Action (choose as needed, always `--json`):
- Module relations: `scopecairn graph <symbol> --json` (add `--budget <n>` for large monorepos)
- Blast radius / impact: `scopecairn impact <path> --json`
- Flow A→B: `scopecairn graph <from> --to <to> --json`
- Dependencies: `scopecairn deps --json` (offline manifest health)
Observe: connect hops via `edges[].rel` (`graph`) or `hops[].rel`
(`graph --to`) — relationships CALLS/IMPORTS/QUERIES/ROUTES_TO. Ranking is
5-signal + PageRank/PPR (`wSeed/wProximity/wCentrality/wRecency/wCochange`
plus optional PPR/PR); use `context --explain --format brief` to inspect.
Coverage: languages TS/JS/Python/Java/Go/Rust/PHP/C#/C/C++/Ruby/HTML/Vue/
Kotlin/Dart/Shell/SQL/GraphQL/Proto; frameworks Prisma/Drizzle/SQLAlchemy/
Next.js/Express/FastAPI/NestJS/Django/Vue/Fastify/Koa/Hono/Rails/Laravel/
Spring/Go.
Stop when the chain answers "why / how".

Iteration 3 — Ground:
Thought: what is the historical / source evidence?
Action:
- `scopecairn history "<question>" --json` for decisions + co-changes
  (`empty: true` = no analogs — do not force).
- `scopecairn read symbol <name> --json` for excerpts (do not read full files).
Observe: quote `shortSha + subject` and `file:range` as evidence.

Stop rules: stop when the answer is complete, or 3 iterations reached, or `high`
is stable across iterations. Answer structure: direct answer first, followed by
evidence (`file:line`, `shortSha + subject`), then open questions. Every claim
requires evidence from the commands above — cold start artifacts provide
orientation, not per-task proof. Never write or modify files — only read,
summarize, and explain.
