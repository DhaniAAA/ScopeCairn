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
  in local SQLite, fully deterministic. Parsing uses Tree-sitter
  grammars (bundled WASM); schema files without a grammar keep an
  explicit fallback.
- **Graph retrieval, no embeddings** — token-matched seeds → weighted
  expansion → 5-signal ranking (seed, proximity, centrality, git
  recency, co-change). Weights configurable, calibrated by benchmark.
- **Task scope control** — every complex task returns Required /
  Optional / Protected file lists plus Task Guard rules and a
  Definition of Done, so the agent changes only what matters.
- **Change impact** — direct, indirect (2-hop), tests, and UI components
  affected by a file or symbol.
- **Call path tracing** — `scopecairn path <A> <B>` shows the shortest
  multi-hop call/dependency chain between two symbols.
- **Centrality ranking** — weighted PageRank + betweenness cached per
  symbol; `context` surfaces critical hotspots, `doctor` flags
  single points of failure.
- **Community detection** — Louvain clustering finds real modules by
  link density (not just folders); `graph` shows each symbol's community.
- **Cycle detection** — Tarjan SCC finds circular dependencies;
  reported by `doctor`, warned in `context`, listed in `GRAPH.md`.
- **Auto-refresh** — `context` and `impact` re-index changed files first;
  run `scan` after editing to close the loop.
- **Framework adapters** — Next.js (App + Pages Router routes),
  Prisma models, Drizzle tables/queries, Express, FastAPI, NestJS (controllers, routes, injectables), Django (urls, models), SQLAlchemy, and Vue SFC detected automatically.
- **Multi-language** — TypeScript, JavaScript, Python, Java, Go, Rust,
  PHP, C#, C/C++, Ruby, HTML, Vue SFC (plus config/schema files as
  graph nodes).
- **Multi-agent setup** — skills for Claude Code (plugin + marketplace
  ready), Antigravity, Cursor, Windsurf, Copilot, Kiro, and an OpenCode
  slash command. ScopeCairn never touches your `AGENTS.md`/`CLAUDE.md` —
  those hold your repo's details, not tool instructions.
- **`GRAPH.md` knowledge file** — `.scopecairn/GRAPH.md` is a budgeted
  (±150 lines) frozen summary of the graph (modules, most-used symbols,
  PageRank hotspots, circular dependencies, routes, models, protected).
  Written on setup, rewritten only when the
  graph changes — for cold-start orientation; per-task precision still
  comes from `context`. `.scopecairn/ARCHAEOLOGY.md` (purely from local
  `git log`: top author, bus factor, churn) is written once; delete it to
  regenerate.
- **`GRAPH.html` visual explorer** — offline, dependency-free Canvas
  explorer written next to `GRAPH.md` on every graph change.
  Cluster ↔ File ↔ Symbol hierarchy toggle, live search, type filter,
  click-for-details side panel (callers, callees, centrality scores).
  Nodes sized by symbols/PageRank, colored by Louvain community.
  Pan, zoom, hover inspect. Double-click to open, no server.
- **`export` for external tools** — `scopecairn export --format
  mermaid|graphml|dot|json` writes `.scopecairn/graph.<ext>` for PR
  diagrams (Mermaid), Gephi/Cytoscape (GraphML), Graphviz (DOT),
  or custom scripts (JSON).

## Install

```bash
npm install -g scopecairn
```

Requires Node.js ≥ 20.

Upgrade later with:

```bash
scopecairn update          # or: npm install -g scopecairn@latest
scopecairn update --check  # only check for a new version
```

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
scopecairn path handleLogin dbQuery
scopecairn export --format mermaid
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
| `scan` / `rebuild` / `clean` | Manual index management (`scan` incremental; `rebuild` from scratch; `clean` removes `.scopecairn/`) |
| `status` / `doctor` | Index status (incl. adapters, invocations) and health checks |
| `context "<task>"` | Main entry point: context + scope (`--escalate`, `--no-refresh`, `--mode NORMAL|FAST|SAFE|AUDIT`, `--max-tokens N`); a path task returns an orientation map |
| `impact <path\|symbol>` | Change impact: direct, indirect, tests (via TESTS edges + static CALLS backward reachability), UI, queries, routes. Edge evidence tagged EXTRACTED/INFERRED/AMBIGUOUS |
| `graph <symbol>` | Symbol relations (+ PageRank, community, cycle status) |
| `path <from> <to>` | Shortest multi-hop call/dependency path between two symbols |
| `export --format <fmt>` | Graph export: `mermaid`, `graphml`, `dot`, or `json` (default `.scopecairn/graph.<ext>`, override with `--out`) |
| `read symbol <name>` | Symbol-level source excerpt (not whole files) |
| `<agent> install` | Per-agent setup: `antigravity`, `claude`, `gemini`, `cursor`, `windsurf`, `copilot`, `kiro` (each also `uninstall`; `agents list` to see all) |
| `dashboard` | Generate local HTML dashboard at `.scopecairn/dashboard.html` |
| `test-select <target> [--run]` | List affected test files via graph dependency traversal & runner detection (`--run` executes runner) |
| `verify [--task <t>] [--strict]` | Post-edit guard: check modified protected files, task scope creep, and circular dependency regressions |
| `diff` | Structural symbol-level diff of working tree vs HEAD with breaking impact alerts |
| `arch-check [--init]` | Check architectural layer rules & disallowed import boundaries (`--init` scaffolds `.scopecairn/arch.json`) |
| `watch [--debounce <ms>]` | Daemon mode: auto-refresh index in background on file saves |
| `doctor --verbose` | Also surface adapter/graph errors from `.scopecairn/last-run.log` to stderr |
| `benchmark [--tune]` | Retrieval recall, irrelevant ratio, context reduction + weight calibration |
| `update [--check]` | Update ScopeCairn to the latest npm release (`--check` only checks) |

Agent commands (`context`, `impact`, `read`, `graph`, `status`, `doctor`, `verify`, `diff`, `test-select`, `arch-check`)
are read-only toward source and only write to `.scopecairn/` — safe to
allowlist. `init`, `scan`, `rebuild`, and `watch` are manual/user-side commands.

## Framework adapters

Detected automatically during `scan` (shown in output and `status`).
No configuration needed.

| Adapter | Detects | Produces |
|---|---|---|
| `nextjs` | `app/`, `pages/`, `next.config.*` | Route symbols (`GET /api/x`, `PAGE /y` incl. route groups, dynamic segments), `ROUTES_TO` handler edges, `QUERIES` handler→model edges |
| `prisma` | `schema.prisma` | `model` symbols for `QUERIES` resolution |
| `drizzle` | `drizzle*` paths/config, `db/` schemas | `model` symbols from `pgTable`/`sqliteTable`/`mysqlTable`; `QUERIES` from `db.query.*` relational and `db.select/insert/update/delete` builder calls |
| `express` | `package.json` deps | Route symbols from `app/router.METHOD(path)`, handler edges |
| `fastapi` | `.py` routes, requirements/pyproject | Route symbols from `@app.METHOD("/path")` decorators |
| `nestjs` | `*.controller.ts`, `*.service.ts`, `nest-cli.json` | Route symbols from `@Controller` and `@Get/@Post/...` decorators, `ROUTES_TO` handler edges, `@Injectable()` service providers |
| `django` | `manage.py`, `urls.py`, `models.py` | Route symbols from `path()`/`re_path()` in `urls.py`, `ROUTES_TO` handler edges, `model` symbols from `models.Model` |
| `sqlalchemy` | requirements/pyproject | `model` symbols from `class X(Base)`/`__tablename__`; `QUERIES` from `session.query/select` |
| `vue` | `.vue` SFCs, `package.json` deps | `component` symbols per SFC; `IMPORTS` edges from used components in template |

Limits (honest): non-Prisma/Drizzle/SQLAlchemy ORMs, inter-table
references, raw SQL strings, and fully dynamic table names are not mapped
yet — those edges are skipped (and logged to `.scopecairn/last-run.log`),
never hallucinated. Server Actions (`detectServerActions`) and middleware
(`detectMiddleware`) are detected in `nextjs.ts`. QUERIES re-derive on
every scan so new models resolve without a rebuild.
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
