# OpenCode working notes (repo-specific)

Local-first codebase-intelligence CLI. Node ≥20, ESM, single package (no monorepo).
Entry: `src/cli.ts` → `dist/cli.js` (tsup bundle). No MCP / embeddings / network.

## Commands (exact)

- Run without building: `npx tsx src/cli.ts <cmd>` (e.g. `npx tsx src/cli.ts context "..."`)
- Verify order: `npm run typecheck` then `npm test`
- Single test file: `npx tsx --test tests/<name>.test.ts` (full suite ~30s / ~100 tests)
- Build: `npm run build` (tsup; `tsup.config.ts:onSuccess` copies tree-sitter WASM grammars into `dist/grammars`)
- Release: bump `package.json` → `node scripts/changelog.js <version>` → commit `chore: release <version>` (package.json + CHANGELOG.md only) → `git push origin master` → `git tag -a v<version>` + push tag. Branch is **master**, not main.

## Architecture (where things live)

- `src/cli.ts` — 6 visible commands (`scan/context/impact/graph/verify/status`) + setup helpers (`init/read/decide/benchmark/<agent> install`). Old command names survive as hidden aliases; `update` is deprecated (use `npm install -g scopecairn@latest`).
- `src/commands/` — one file per command. `src/retrieval/` — token-match → expand → 5-signal ranking. `src/graph/` — PageRank/betweenness, Tarjan cycles, Louvain communities. `src/extract/` — tree-sitter parsing.
- `src/adapters/` — framework detectors (Next.js, Prisma, Drizzle, Express, FastAPI, NestJS, Django, SQLAlchemy, Vue). New adapter = 1 file + 1 registration line in `src/adapters/index.ts` (see `FrameworkAdapter` in `src/adapters/types.ts`).
- `src/integrate/` — per-agent installers: `matrix.ts` (target list), `templates.ts` (file bodies), `install.ts` (write/remove), `detect.ts` (env detection).
- `src/scope/agentsmd.ts` — **reads** (never writes) `AGENTS.md`/`agents.md` as Project Rules for `context`.

## Gotchas

- `scopecairn` on PATH is usually a **global install (separate copy)** — local `src/` edits don't affect it. Test via `npx tsx` / `node dist/cli.js`; reinstall global only when asked.
- `dist/`, `node_modules/`, `.scopecairn/` (local SQLite index) are gitignored — never commit them.
- Shell is Windows PowerShell 5.1: no `head`/`cat`; chain with `; if ($?)`, quote paths with spaces.
- Repo dogfoods itself: generated `.agents/...` skill files are committed; root `workflows/` is legacy (workflow lives in `.agents/workflows/`).
- Commits are conventional (`feat:`/`fix:`/`docs:`/`chore:`/`refactor(scope):`); if a commit is rejected, make a new one — never amend.
