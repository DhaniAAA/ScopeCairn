# Required / Optional / Protected: Stop AI From Touching the Wrong Files

> Evergreen guide to ScopeCairn's scope control. The pattern that keeps AI coding agents from breaking migrations, lockfiles, and production config.

## Why agents break things

Without scope control, an agent asked to "fix a button" will:

1. Rewrite 3 unrelated modules "while I'm at it"
2. Edit `prisma/migrations`, `package-lock.json`, or `.env.example`
3. Skip tests because "they still pass locally"

ScopeCairn solves this with three lists returned on every `context` call.

## The three lists

Given a task, ScopeCairn classifies every candidate file:

- **Required** — change these to complete the task (HIGH-score symbols live here)
- **Optional** — safe to read, change only if needed (MEDIUM + co-change history + tests)
- **Protected** — never touch without human approval (from `.scopecairn/protected.yml`: `migrations/**`, `*.sql`, `.env*`, lockfiles, etc. — last pattern wins, `!` negates)

```bash
scopecairn context "add coupon to checkout"
```

Output ends with something like:

```
## Scope
Required: src/checkout/price.ts, src/checkout/coupon.ts
Optional: tests/checkout.test.ts
Protected: prisma/migrations/20240101_init.sql
```

Rule: **change only Required + Optional.**

## Setting up protected patterns

`.scopecairn/protected.yml`:

```yaml
patterns:
  - "prisma/migrations/**"
  - "**/*.sql"
  - ".env*"
  - "package-lock.json"
  - "!docs/**"
```

Verify with:

```bash
scopecairn verify --task "add coupon to checkout"
scopecairn verify --task "add coupon" --strict --json
```

`--strict` fails CI if the working tree touches anything outside scope.

## The full guard workflow

```bash
# 1. Scope the task (escalate if it grows past 2 files)
scopecairn context "add coupon to checkout"
scopecairn context --escalate "add coupon to checkout"

# 2. Impact of shared symbols
scopecairn impact src/checkout/price.ts --json

# 3. Which tests cover the change?
scopecairn test-select src/checkout/price.ts --json

# 4. After editing: architecture + scope check
scopecairn arch-check --json
scopecairn verify --task "add coupon to checkout" --json

# 5. Keep the index fresh
scopecairn scan
```

## For knowledge tasks

Explaining, documenting, or auditing? Skip scope enforcement entirely:

```bash
scopecairn context --knowledge "how is pricing computed?" --json
```

You get `Ringkasan + Kenapa + Cara pakai` — no `Required/Optional/Protected`, no `DoD` coding checklist misleading a read-only task.

## Checklist

- [ ] `protected.yml` reviewed for your stack
- [ ] Agent changes only Required / Optional
- [ ] `impact` + `test-select` before shared-symbol edits
- [ ] `verify --strict` in CI
- [ ] `--knowledge` for read-only questions

Minimal scope is not laziness — it is how you ship AI-generated code without regressions.
