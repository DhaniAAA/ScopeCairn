# ScopeCairn

Local-first codebase intelligence layer for AI coding agents.
Builds a knowledge graph of your repository, retrieves only the context
relevant to the current task, analyzes change impact, and enforces
minimal-work scope. No MCP server, no embeddings, no network calls.

> Understand before exploring. Retrieve before reading.

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
scopecairn init      # index + generate AGENTS.md, Skill, Workflow
```

After setup, your agent calls ScopeCairn automatically on every coding task.
To query manually:

```bash
scopecairn context "add approval workflow"
scopecairn impact src/request/RequestService.ts
scopecairn read symbol approveRequest
scopecairn graph RequestService
scopecairn doctor
```

## Commands
| Command | Description |
|---|---|
| `init` | Initial indexing + generate `AGENTS.md`, Skill, Workflow |
| `scan` / `rebuild` / `clean` | Manual index management |
| `status` / `doctor` | Index status and health checks |
| `context "<task>"` | Main entry point: context + scope (`--escalate`, `--no-refresh`) |
| `impact <path\|symbol>` | Change impact analysis |
| `graph <symbol>` | Symbol relations |
| `query "<text>"` | Symbol search |
| `read symbol <name>` | Symbol-level source excerpt |
| `benchmark [--tune]` | Retrieval recall and weight calibration |

## Framework adapters

Detected automatically during `scan` (shown in output and `status`).
No configuration needed.

| Adapter | Detects | Produces |
|---|---|---|
| `nextjs` | `app/`, `pages/`, `next.config.*` | Route symbols (`GET /api/x`, `PAGE /y` incl. route groups, dynamic segments), `ROUTES_TO` handler edges, `QUERIES` handler→model edges |
| `prisma` | `schema.prisma` | `model` symbols for `QUERIES` resolution |
| `drizzle` | `drizzle*` paths/config, `db/` schemas | `model` symbols from `pgTable`/`sqliteTable`/`mysqlTable`; `QUERIES` from `db.query.*` relational and `db.select/insert/update/delete` builder calls |

Limits (honest): Server Actions, middleware, and non-Prisma/Drizzle ORMs are not
mapped yet. QUERIES re-derive on every scan so new models resolve without
a rebuild. Contributing a new adapter = one file + one registration line
in `src/adapters/index.ts` (see `FrameworkAdapter` in `src/adapters/types.ts`).

## License

MIT — see [LICENSE](./LICENSE).
