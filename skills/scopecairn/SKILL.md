---
name: scopecairn
description: Set up ScopeCairn codebase intelligence, then use it for coding
  tasks. Use when the user says "scopecairn", "scopecairn ./",
  "scopecairn <path>", asks to index a repo for an AI agent, asks for a
  repo overview, or for ALL coding tasks (feature, bugfix, refactor)
  before exploring the repo.
allowed-tools: Bash
---

# ScopeCairn

## Setup (bila `.scopecairn/scopecairn.db` belum ada)

1. Resolve path: `.`/`./` = direktori proyek saat ini.
2. Jalankan `scopecairn init <path>` (`npx -y scopecairn init <path>`
   bila CLI belum ada; atau `npm install -g scopecairn` dulu).
3. Laporkan singkat: file terindex, simbol, relasi, adapter,
   file integrasi yang ditulis. Berhenti setelah setup.

## Tiap task coding (bila index sudah ada)

1. Jalankan `scopecairn context "<task user>"`.
   Mulai dari Relevant Files. Jangan menjelajah dari nol.
2. Ubah hanya Required/Optional; Protected perlu persetujuan user.
   Simbol bersama → `scopecairn impact <path>`.
   Butuh isi fungsi → `scopecairn read symbol <nama>`, bukan baca file penuh.
3. Task membesar (>2 file)? Panggil ulang `scopecairn context --escalate`.
4. Setelah mengedit: `scopecairn scan`.
   Berhenti saat acceptance criteria terpenuhi.
