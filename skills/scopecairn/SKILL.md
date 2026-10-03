---
name: scopecairn
description: Set up ScopeCairn codebase intelligence in a repository. Use when the user says "scopecairn", "scopecairn ./", "scopecairn <path>", asks to index a repo for an AI agent, or wants the agent to understand a codebase with ScopeCairn.
---

# ScopeCairn setup

The user invoked ScopeCairn with a path (e.g. `scopecairn ./`).
Your job: run project setup so this repo becomes agent-readable.

## Steps

1. Resolve the path: `.` or `./` means the current project directory.
   A relative or absolute path means that directory.
2. Run setup in that directory:
   `scopecairn init <path>` (or `npx -y scopecairn init <path>` if it is not installed).
3. If the command is not found, install globally first
   (`npm install -g scopecairn`), then retry step 2.
4. Report back, briefly: files indexed, symbols, relationships,
   detected adapters, and which integration files were written
   (AGENTS.md, Skill, Workflow, agent matrix).

## Rules

- Setup is read-only toward source code. `init` only adds/updates
  `AGENTS.md` (marker block), the agent Skill, the Workflow file,
  and the `.scopecairn/` index directory. Never refactor user code.
- If a terminal command needs approval, ask once — after setup,
  recommend the user allowlist the read-only commands printed by `init`.
- After setup, coding tasks go through `scopecairn context "<task>"`,
  never by re-exploring the repository from zero.
