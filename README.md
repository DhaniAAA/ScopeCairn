# ScopeCairn

Local-first codebase intelligence layer for AI coding agents.
Understand the codebase, then give the agent only what it needs:
a knowledge graph of the repository, the relevant context per task,
change impact analysis, and enforced minimal-work scope.
No MCP server, no embeddings, no network calls, no telemetry.

> Understand before exploring. Retrieve before reading.

## Features

- **Knowledge graph** — files, symbols (functions, classes, methods,
  interfaces, components, routes, models…), and typed relations
  (`IMPORTS`, `CALLS`, `EXTENDS`, `TESTS`, `ROUTES_TO`, `QUERIES`…)
  in local SQLite, fully deterministic.
- **Graph retrieval, no embeddings** — token-matched seeds → weighted
  expansion → 5-signal ranking (seed, proximity, centrality, git
  recency, co-change). Weights configurable, calibrated by benchmark.
- **Task scope control** — every complex task returns Required /
  Optional / Protected file lists plus Task Guard rules and a
  Definition of Done, so the agent changes only what matters.
- **Change impact** — direct, indirect (2-hop), tests, and UI components
  affected by a file or symbol.
- **Auto-refresh** — `context` and `impact` re-index changed files first;
  run `scan` after editing to close the loop.
- **Framework adapters** — Next.js (App + Pages Router routes),
  Prisma models, and Drizzle tables/queries detected automatically.
- **Multi-language** — TypeScript, JavaScript, Python, Java, Go, Rust,
  PHP, C#, C/C++, Ruby, HTML (plus config/schema files as graph nodes).
- **Multi-agent setup** — skills for Claude Code (plugin + marketplace
  ready), Antigravity, Cursor, Windsurf, Copilot, Kiro, and an OpenCode
  slash command. ScopeCairn never touches your `AGENTS.md`/`CLAUDE.md` —
  those hold your repo's details, not tool instructions.

## Install

```bash
npm install -g scopecairn
```

Requires Node.js ≥ 20.

## Agent-driven setup

Install once, then just type `scopecairn ./` to your AI agent —
it runs project setup itself.

1. Install the skill once (global):
   ```bash
   npx skills add <github-user>/scopecairn -g
   ```
   (fallback without a skill: add one line to your global agent
   instructions — `~/.claude/CLAUDE.md` or equivalent: *When the user
   writes "scopecairn \<path\>", run `scopecairn init \<path\>`.*)
2. In any project chat, type:
   ```
   scopecairn ./
   ```
   The agent runs `scopecairn init ./`, reports files indexed and
   integration files written. Approve the terminal command once;
   afterwards, add the printed allowlist so later calls need no approval.

## Quickstart (manual)

```bash
cd your-repo
scopecairn init      # index + Antigravity Skill + Workflow
```

Claude Code (project skill, committed with the repo):

```bash
scopecairn claude install
```

Or as a plugin from the bundled marketplace (this repo):

```
/plugin marketplace add <github-user>/scopecairn
/plugin install scopecairn@scopecairn
```

After setup, your agent calls ScopeCairn automatically on every coding task.
To query manually:

```bash
scopecairn context "add approval workflow"
scopecairn context ./                 # repository orientation map
scopecairn impact src/request/RequestService.ts
scopecairn read symbol approveRequest
scopecairn graph RequestService
scopecairn doctor
```

Per-agent installers (instead of `init --agents …`):

```bash
scopecairn antigravity install   # Skill + Workflow + allowlist guide
scopecairn claude install        # project skill .claude/skills (also: cursor, windsurf, copilot, kiro)
scopecairn opencode install      # /scopecairn slash command + permission snippet
scopecairn claude uninstall      # clean removal, user content preserved
scopecairn agents list
```

## Commands

| Command | Description |
|---|---|
| `init [path]` | Initial indexing + Skill, Workflow, detected agent skills (`--agents …\|all`; never writes `AGENTS.md`) |
| `scan` / `rebuild` | Manual index management (`scan` inkremental; `rebuild` dari nol) |
| `status` / `doctor` | Index status (incl. adapters, invocations) and health checks |
| `context "<task>"` | Main entry point: context + scope (`--escalate`, `--no-refresh`); a path task returns an orientation map |
| `impact <path\|symbol>` | Change impact: direct, indirect, tests, UI, queries, routes |
| `graph <symbol>` | Symbol relations |
| `read symbol <name>` | Symbol-level source excerpt (not whole files) |
| `<agent> install` | Per-agent setup: `antigravity`, `claude`, `gemini`, `cursor`, `windsurf`, `copilot`, `kiro` (each also `uninstall`; `agents list` to see all) |
| `benchmark [--tune]` | Retrieval recall, irrelevant ratio, context reduction + weight calibration |

Agent commands (`context`, `impact`, `read`, `graph`, `status`, `doctor`)
are read-only toward source and only write to `.scopecairn/` — safe to
allowlist. `init`, `scan`, and `rebuild` are manual/user-side commands.

## Framework adapters

Detected automatically during `scan` (shown in output and `status`).
No configuration needed.

| Adapter | Detects | Produces |
|---|---|---|
| `nextjs` | `app/`, `pages/`, `next.config.*` | Route symbols (`GET /api/x`, `PAGE /y` incl. route groups, dynamic segments), `ROUTES_TO` handler edges, `QUERIES` handler→model edges |
| `prisma` | `schema.prisma` | `model` symbols for `QUERIES` resolution |
| `drizzle` | `drizzle*` paths/config, `db/` schemas | `model` symbols from `pgTable`/`sqliteTable`/`mysqlTable`; `QUERIES` from `db.query.*` relational and `db.select/insert/update/delete` builder calls |

Limits (honest): Server Actions, middleware, non-Prisma/Drizzle ORMs,
inter-table references, raw SQL strings, and fully dynamic table names
are not mapped yet — those edges are skipped silently, never hallucinated.
QUERIES re-derive on every scan so new models resolve without a rebuild.
Contributing a new adapter = one file + one registration line
in `src/adapters/index.ts` (see `FrameworkAdapter` in `src/adapters/types.ts`).

## Typical loop

```
prompt → scopecairn context (refresh at start) → agent edits code
       → scopecairn scan (refresh at end, incremental, ~instant)
```

Measure retrieval quality anytime: `scopecairn benchmark [--tune]`.

## License

MIT — see [LICENSE](./LICENSE).
