# /scopecairn

Manual shortcut if the agent forgets to run the automated ScopeCairn protocol.

Automated Principles:
- Laziness Protocol (minimal diff, no slop, never add unnecessary abstraction layers).
- Blast Radius: Shared symbols require impact + safety fact + proof via tests.
- Anti-Looping: 2x failure on the same test → stop and attack underlying premises independently before a 3rd try.
- Prove It Works: Always prove fixes/features with real tests before declaring completion.
- Status Cue: Start response with a 1-line scope indicator, e.g. `> 🧭 [ScopeCairn: ...]`.

Workflow Steps:
1. At the start of a session, run `scopecairn session load` to inspect previous state and commits/files changed since the last save.
2. If user prompt is long/complex, extract 2–4 technical keywords as context arguments.
3. Run `scopecairn context "<technical keywords>"` (if target files are unknown or to lock scope). For score debugging, add `--explain`; for human copy, add `--format brief|table|tree|mermaid`; for fast rescan after a small change, prefer `scan --changed-only`.
4. Follow Relevant Files and Task Scope (Required & Optional; never touch Protected without approval).
5. Before creating a new function or class, run `scopecairn reuse "<description or signature>"`.
6. Need to check impact of changes? `scopecairn impact <path> --run-tests`.
7. Need symbol source code? `scopecairn read symbol <name>` (multi: `scopecairn read symbol a b c --full --with-callers`).
8. Check dependencies? `scopecairn deps` (offline, from manifests).
9. Before PR/merge? `scopecairn verify --pr-risk --sarif --base origin/main`.
10. Architectural decision settled? `scopecairn decide "<choice> because <why>"`.
11. Before declaring completion:
   - Adversarial self-review: check null/undefined/edge-cases, async race conditions, OS compatibility.
   - Prove changes with real tests.
   - Run `scopecairn scan`, `scopecairn dead`, then `scopecairn verify --task "<technical keywords>" --strict`
     — ensuring no dead code was introduced and modified files did not leak outside scope.
   - Save session state via `scopecairn session save --working "<summary>" --decisions "<decisions>" --next "<next>" --blockers "<blockers>" --files "<files>"`.
Prereq (CI): `scan --lsp` only when LSP exists; `benchmark --tune` reports nDCG/MRR for weight calibration.
