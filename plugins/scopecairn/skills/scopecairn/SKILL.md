---
name: scopecairn
description: ScopeCairn codebase context + scope. Use for ALL coding tasks
  (feature, bugfix, refactor, code questions) before exploring the repo,
  and when the user says "scopecairn", asks for a repo overview, or asks
  to set up ScopeCairn.
allowed-tools: Bash
---

# ScopeCairn

1. Jika `.scopecairn/scopecairn.db` belum ada: jalankan `scopecairn init`
   (bila CLI belum ada: `npm install -g scopecairn`), laporkan file/simbol/relasi, berhenti.
2. Jika sudah ada: jalankan `scopecairn context "<task user>"`.
   Mulai dari Relevant Files. Jangan menjelajah dari nol.
3. Ubah hanya Required/Optional; Protected perlu persetujuan user.
   Simbol bersama → `scopecairn impact <path>`.
   Butuh isi fungsi → `scopecairn read symbol <nama>`, bukan baca file penuh.
4. Task membesar (>2 file)? Panggil ulang `scopecairn context --escalate`.
5. Setelah mengedit: `scopecairn scan`. Berhenti saat acceptance criteria terpenuhi.
