# Changelog

## 0.13.0 (2026-10-16)

- chore(integrate): template sebut decide + regenerasi file dogfood (112b1ee)
- fix(retrieval): arah edge TESTS di related tests contextBuilder (882941d)
- feat: command decide, status --usage, verify --dod (073ec67)
- fix(integrate): workflow Antigravity ke .agents/workflows (hapus legacy root workflows/) (1e5db5c)

## 0.12.1 (2026-10-16)

- docs: add project branding assets and update README and package configuration (671a813)
- fix(integrate): workflow Antigravity pindah ke `.agents/workflows/scopecairn.md`, doctor/uninstall selaras + bersihkan legacy `workflows/`

## 0.12.0 (2026-10-15)

- refactor(cli): konsolidasi 21 command jadi 8 visible - 11 alias + benchmark/update hidden, update deprecated ke npm, README diperbarui (720972f)
- fix(graph): blank GRAPH.html dan tombol navbar mati - escape newline di template literal, default view Files, filter tipe hanya untuk symbols, edge intra-community jadi self-loop (9c3615d)

## 0.11.0 (2026-10-14)

- fix(graph): improve node sizing, module coloring, camera controls, and label visibility in visual graph (589c5ec)
- docs: align README, blog, and CLI help with 6 core commands and real codebase symbols (9690e63)
- feat: implement semantic typed code graph and consolidate to 6 core commands (8fb32c0)
- docs: add repo CTA to understand-before-exploring (d95e729)
- docs: 2 evergreen tutorials for AI coding agents (3ec42a3)

## 0.10.0 (2026-10-10)

- feat(history): analogi riwayat git di context + history CLI + leave-one-out benchmark (1b6619b)
- feat: edge CALLS_API klien HTTP ke route + seksi Klien terpengaruh di impact (f2efc49)

## 0.9.0 (2026-10-10)

- feat: add framework adapters, AST extraction, and CLI commands for codebase analysis (859bc9a)
- fix(retrieval): bawaan glossary morfologi di template fresh install (21b523a)
- feat(benchmark): perluas dataset 12 ke 20 task cegah overfit (b3403e8)
- feat(impact): seksi endpoints, models, dan risk plus bukti file:line (81e73b6)
- feat(context): related tests 2-hop di contextBuilder (4d74df0)
- feat(retrieval): stemming ringan, fallback file config, demosi cocok-tunggal lemah (fd83987)
- fix(benchmark): escape sel tabel, nama jelas, komentar konsisten (9971b38)

## 0.8.0 (2026-10-08)

- fix(changelog): compute previous tag before the release tag (d57b5c9)
- ci: nicer release workflow (tag/version check, per-tag notes, npm pack artifact) (c2d31cc)
- Merge main: tree-sitter migration + knowledge quick wins (0.8.0) (9d45c6e)
- feat: tree-sitter migration + knowledge quick wins (043e0fa)
- Merge pull request #2 from DhaniAAA/main (e51a2b5)
- Merge pull request #1 from DhaniAAA/main (f1b5ebb)

## 0.7.0 (2026-10-07)

- fix: unified QUERIES refresh across adapters, orphan cleanup, graph/maintenance tests, release workflow (690fa68)

## 0.6.0 (2026-10-07)

- feat: framework adapters, error logging, dashboard, test-select, context modes, tests + CI (a765189)

## 0.4.0 (2026-10-06)

- refactor!: skill-first distribution, stop writing AGENTS.md (55498a1)
- feat: multilingual extraction, per-agent installers, simplified CLI (6c78720)
- feat: initialize ScopeCairn codebase with core indexing, AST extraction, and CLI commands (d0163a0)
