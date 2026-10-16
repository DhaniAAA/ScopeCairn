---
name: scopecairn
description: Gunakan untuk SEMUA task coding (fitur baru, bug fix, refactor,
  pertanyaan tentang kode) sebelum menjelajah repository.
---

Langkah:
1. Jalankan `scopecairn context "<permintaan user>"`.
2. Baca bagian Relevant Files dan Task Scope.
3. Jika ada perubahan pada simbol bersama, jalankan `scopecairn impact <path>`.
4. Kerjakan task sesuai scope, lalu berhenti saat selesai.
5. Setelah mengedit, jalankan `scopecairn scan` agar indeks ScopeCairn mutakhir.
6. Ada keputusan arsitektur yang disepakati? Catat dengan
   `scopecairn decide "<pilihan> karena <alasan>"` — terbaca di context berikutnya.
