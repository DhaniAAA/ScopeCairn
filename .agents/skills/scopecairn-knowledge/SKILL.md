---
name: scopecairn-knowledge
description: ScopeCairn cold-start map + context extraction for knowledge tasks —
  explain, summarize, document, audit, "how does X work", "why is it like this",
  architecture overview, ownership or bus factor. Read-only — never for code changes.
---

# ScopeCairn — Knowledge Mode (ReAct)

Reasoning loop: Thought → Action → Observe, max 3 iterasi. Semua Action
read-only terhadap source; ScopeCairn hanya menulis ke `.scopecairn/`.

Iteration 0 — Cold start (lewati yang tidak ada):
Thought: apa yang sudah diketahui repo ini tanpa query apa pun?
Action: baca berurutan:
- `.scopecairn/GRAPH.md` — peta graph berbudget: modul, simbol paling dipakai,
  hotspot PageRank, siklus, rute, model, protected.
- `.scopecairn/ARCHAEOLOGY.md` — kepemilikan/bus factor/churn dari git log lokal
  (snapshot sekali tulis; hapus file untuk regenerasi).
- `.scopecairn/decisions.md` — keputusan arsitektur yang tercatat (dicatat
  user/agent lewat `scopecairn decide`), bila ada.
Observe freshness: GRAPH.md memuat baris
`> Freshness: scanned <ISO> · HEAD <sha>` (bila tidak ada — mis. index lama —
lewati cek ini). Bila ada, bandingkan <sha> dengan `git rev-parse --short HEAD`;
bila berbeda, sebut peta mungkin usang dan percayai command live untuk yang
berubah. Cold start = orientasi, bukan jawaban.

Iteration 1 — Scope:
Thought: apa yang sebenarnya ditanyakan?
Action: `scopecairn context --knowledge "<pertanyaan user>" --json`
Observe: cek `high`, `medium`, `symbols[0].score`, `analogs`, `empty`.
- `high` DAN `medium` kosong / semua score <0.15 → reformulasi sekali (alias
  domain dari `.scopecairn/glossary.yml`, pecah jadi 2 sub-pertanyaan), lalu
  lanjut dari cold start — jangan berhenti.
- `high` kosong tapi `medium` berisi → normal untuk task SIMPLE; lanjut.
- `analogs` = commit yang menyentuh area sama: bukti "kenapa". Kutip
  `shortSha + subject`.
- Keputusan arsitektur: pada output markdown sudah terlampir di akhir
  (`## Keputusan Arsitektur`); pada `--json` baca `.scopecairn/decisions.md`
  langsung (envelope JSON tidak memuatnya).

Iteration 2 — Expand:
Thought: simbol mana yang perlu trace relasi?
Action (pilih seperlunya, selalu `--json`):
- Relasi modul: `scopecairn graph <symbol> --json`
- Dampak: `scopecairn impact <path> --json`
- Alur A→B: `scopecairn graph <from> --to <to> --json`
Observe: sambungkan hop via `edges[].rel` (`graph`) atau `hops[].rel`
(`graph --to`) — rel CALLS/IMPORTS/QUERIES.
Stop bila rantai sudah menjawab "kenapa / bagaimana".

Iteration 3 — Ground:
Thought: apa bukti historis / source-nya?
Action:
- `scopecairn history "<pertanyaan>" --json` untuk keputusan + co-change
  (`empty: true` = tidak ada analog — jangan dipaksa).
- `scopecairn read symbol <nama> --json` untuk excerpt (bukan baca file penuh).
Observe: kutip `shortSha + subject` dan `file:range` sebagai bukti.

Stop rules: berhenti saat jawaban cukup, atau 3 iterasi, atau `high` stabil
antar iterasi. Bentuk jawaban: jawaban dulu, lalu bukti (`file:line`,
`shortSha + subject`), lalu pertanyaan terbuka. Setiap klaim butuh bukti dari
command di atas — artefak cold start adalah orientasi, bukan bukti per-task.
Jangan menulis atau mengubah file — hanya baca, rangkum, dan jelaskan.
