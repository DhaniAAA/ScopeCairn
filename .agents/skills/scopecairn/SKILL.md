---
name: scopecairn
description: ScopeCairn codebase context + scope + engineering rigor. Use for coding tasks when target files are unknown or to enforce verification scope.
---

# ScopeCairn — Automated Engineering Protocol

## 1. Discipline (Anti-Slop & Laziness Protocol)
- **Minimal Diff**: Smallest change that solves the problem; bias to deletion; no unrequested abstractions or narrative step comments.
- **Boundaries & History**: Validate at I/O/CLI boundaries; keep core logic pure; check git blame before deleting unusual edge-case guards.

## 2. Context Retrieval & Status Cue
- **First line of EVERY response**:
  - Called context: `> 🧭 [ScopeCairn: context "<query>" → N files in scope]`
  - Skipped context: `> 🧭 [ScopeCairn: scope known (<reason>), context skipped]`
  - Checked impact / verified: `> 🧭 [ScopeCairn: impact <path> checked]` / `> 🧭 [ScopeCairn: verify passed within scope]`
- **Cold start**: If `.scopecairn/scopecairn.db` is missing, run `scopecairn init`. At the start of a session, run `scopecairn session load` to restore previous working state and git drift.
- **Run `scopecairn context "<2-4 technical keywords>"` ONLY IF** target files/symbols are unknown or locking edit scope. If results are empty/off-target, run `scopecairn map [dir]` then `scopecairn context --anchor <path> "<query>"`.
- **SKIP `scopecairn context` IF**: (1) user named the target file/symbol, (2) prompt is Q&A/architecture/review, or (3) scope is already known in this session.
- **Retrieval Options**: Use `scopecairn context --explain` for score breakdown (wSeed*seed, prox, cent, recency, cochange, ppr, pr), `scopecairn context --format brief` for 1-line-per-file human copy, `scopecairn context --format table|tree|mermaid` for tables/trees/call-paths.

## 3. Execution & Verification
- **Scope**: Edit only Required/Optional files; never touch Protected without approval. If >2 files change, run `scopecairn context --escalate "<query>"`.
- **Reuse Check**: Before creating a new function or class, run `scopecairn reuse "<description or signature>"` and reuse/extend existing symbols when matched.
- **Shared Symbols**: Run `scopecairn impact <path>`, state 1 safety fact, and prove it via `scopecairn impact <path> --run-tests`.
- **Anti-Looping**: 2 failed fixes on the same test → stop and test the root-cause premise independently before a 3rd edit.
- **Excerpts**: Prefer `scopecairn read symbol <name>` or line-ranged reads from `context` over full-file reads. Multi-symbol: `scopecairn read symbol a b c` with `--full`/`--with-callers`.
- **Scan Fast Path**: Run `scopecairn scan --changed-only` for incremental git-aware rescan; `scopecairn scan --lsp` only when LSP (tsserver/gopls/pyright) is available.
- **PR Risk**: Before merge, run `scopecairn verify --pr-risk --sarif --base origin/main` for aggregate HIGH/MED/LOW risk + SARIF output. `--pr-risk --json` includes full report.
- **Dependencies**: Run `scopecairn deps` (offline) to check unused/outdated from manifests (package.json/pyproject.toml/go.mod/Cargo.toml).
- **Before Done**: Self-review edge/async/OS cases, prove with tests (never weaken tests by removing assertions, adding `.skip`, or loosening matchers), then run `scopecairn scan`, `scopecairn dead`, `scopecairn verify --task "<query>" --strict --test-gate`, and `scopecairn session save --working "<summary>" --decisions "<decisions>" --next "<next>" --blockers "<blockers>" --files "<files>"`. Never bypass git pre-commit hooks with `--no-verify`; teams should also enforce `scopecairn verify --test-gate --base origin/main` in CI. Coverage: per-symbol coverage is stored (see testGate); retrieval weights tuned via `scopecairn benchmark --tune` (nDCG/MRR).
- **Decisions**: Record settled architectural choices via `scopecairn decide "<choice> because <why>"` — stored with evidence and included in all future contexts.
- **Coverage**: Supported languages: TS/JS/Python/Java/Go/Rust/PHP/C#/C/C++/Ruby/HTML/Vue/Kotlin/Dart/Shell/SQL/GraphQL/Proto. Frameworks: Prisma/Drizzle/SQLAlchemy/Next.js/Express/FastAPI/NestJS/Django/Vue/Fastify/Koa/Hono/Rails/Laravel/Spring/Go.
