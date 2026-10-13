# Understand Before Exploring: How to Scope AI Coding Tasks

> Evergreen guide for developers using AI coding agents (Claude Code, Cursor, Copilot, OpenCode). Learn to give your agent only the context it needs — no more exploring the repo from zero.

## The problem

AI coding agents fail not because they are dumb, but because they are blind:

- They read whole files instead of the right symbols
- They change 10 files when 2 would do
- They touch migrations, lockfiles, or `.env` by accident
- They burn thousands of tokens exploring from zero

The fix is a habit: **understand before exploring, retrieve before reading.**

## The 3-step loop

### 1. Get task context first

```bash
scopecairn context "add login rate limiting"
```

You get back:

- `Relevant Files` (HIGH / MEDIUM)
- `Key Symbols` with scores and reasons
- `Dependencies`, `Related Tests`, `Circular warning`
- `Scope: Required / Optional / Protected` + `Task Guard`

Start from `Required` + `Optional`. Never explore from zero.

For explain / summarize / audit tasks (no code changes), use knowledge mode:

```bash
scopecairn context --knowledge "how does auth work?"
```

No `Scope` / `Guard` coding rules — just `Ringkasan + Kenapa + Cara pakai`.

### 2. Check impact before changing shared code

```bash
scopecairn impact src/auth/login.ts
scopecairn impact approveRequest
```

Look at `Direct`, `Indirect (2-hop)`, `Tests`, `Risk: HIGH/MED/LOW`. If `fan-in >= 10` or `Protected`, stop and confirm with a human.

### 3. Read symbols, not files

```bash
scopecairn read symbol approveRequest
```

You get a 40-line excerpt with docstring, not a 2000-line file. For pipelines, add `--json`:

```bash
scopecairn context "add login" --json
scopecairn impact src/auth/login.ts --json
scopecairn read symbol approveRequest --json
```

## A complete example

```bash
# 1. Scope
scopecairn context "fix refund double-charge"

# 2. Impact of the suspect
scopecairn impact refundCharge

# 3. Shortest call chain
scopecairn path handleRefund refundCharge --json

# 4. History analogs
scopecairn history "refund double-charge" --with-diff

# 5. Re-index after editing
scopecairn scan
```

## Checklist

- [ ] `context` before `grep` or full reads
- [ ] Change only Required / Optional
- [ ] `impact` for shared symbols
- [ ] `read symbol` instead of full file
- [ ] `scan` after editing

That is the whole discipline. Everything else in ScopeCairn (PageRank hotspots, cycles, communities, GRAPH.md) exists to make these 5 commands precise and local-first — no embeddings, no network, no telemetry.
