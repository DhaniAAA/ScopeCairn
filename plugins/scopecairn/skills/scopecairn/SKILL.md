---
name: scopecairn
description: ScopeCairn codebase context + scope + engineering rigor. Use for coding tasks
  (feature, bugfix, refactor) when target files are unknown or to enforce scope,
  and when the user says "scopecairn", asks for a repo overview, or asks
  to set up ScopeCairn.
allowed-tools: Bash
---

# ScopeCairn — Protokol Engineering Otomatis

## 1. Sikap Kerja Otomatis (Anti-Slop & Laziness Protocol)
Patuhi prinsip ini di setiap baris kode secara otomatis tanpa perlu diminta user:
- **Laziness Protocol (Minimal Diff)**: Buat perubahan sekecil mungkin yang menyelesaikan masalah. Prioritaskan penghapusan kode (bias to deletion). Dilarang membuat layer abstraksi, wrapper, atau interface tambahan yang tidak diminta.
- **Anti-AI Slop**: Hapus komentar naratif yang menceritakan langkah kerja (seperti `// Step 1: add x`, `// Phase 2`). Kode harus mendokumentasikan dirinya sendiri melalui penamaan fungsi, tipe yang presisi, dan assertions. Hindari gaya tulisan AI klise/basa-basi.
- **Boundary & Type Discipline**: Validasi ketat di perbatasan sistem (I/O, argumen CLI, API), dan pertahankan core logic tetap murni (pure functions).
- **Perlindungan Konteks Historis (Why Guard)**: Jangan menghapus kode penanganan kasus khusus yang tampak janggal sebelum mengecek git history/blame, agar tidak membangkitkan bug lama.

## 2. Inisialisasi Task & Pemanggilan Context
- **Cold start**: Jika `.scopecairn/scopecairn.db` belum ada di repository, jalankan `scopecairn init` terlebih dahulu untuk memetakan codebase.
- **Jalankan `scopecairn context "<query>"` HANYA JIKA**:
  1. Memulai fitur baru / bugfix yang belum diketahui letak file dan simbolnya di codebase.
  2. Ingin menetapkan scope pengeditan untuk verifikasi.
- **LEWATI `scopecairn context` JIKA**:
  1. User sudah menyebutkan target file atau fungsinya secara spesifik (misal: "perbaiki bug di src/retrieval/tokenize.ts"). Agent bisa langsung membaca simbol/file tersebut tanpa search context.
  2. Pertanyaan berupa diskusi konseptual, code review, arsitektur, atau sekadar tanya jawab.
  3. Melanjutkan percakapan dalam sesi yang sama di mana scope file sudah diketahui.
- **Ekstraksi Query**: Jika prompt user panjang atau berupa spesifikasi kompleks, jangan masukkan seluruh paragraf ke terminal. Ambil 2–4 kata kunci teknis utama (nama modul, entitas, aksi) sebagai argumen context untuk mencari file jangkar (anchor), sementara detail spesifikasi lengkap tetap diikuti langsung dari prompt user.

Gunakan hasilnya sebagai titik awal. Jangan menjelajah repository dari nol.

## 3. Selama Pengerjaan
- **Batas Scope**: Ubah hanya file di daftar Required dan Optional. Jangan sentuh file di daftar Protected tanpa persetujuan user. Bila ternyata lebih dari 2 file harus diubah, panggil ulang: `scopecairn context --escalate "<query>"`.
- **Blast Radius & Safety Fact**: Sebelum mengubah simbol/file yang dipakai banyak tempat (fan-in tinggi):
  1. Jalankan `scopecairn impact <path>` untuk melihat pemanggil dan tes terdampak.
  2. Rumuskan 1 fakta penjamin keamanan (*the one safety fact it is safe because of*).
  3. Buktikan fakta tersebut dengan menjalankan tes terkait (`scopecairn impact <path> --run-tests` atau test runner) sebelum lanjut.
- **Anti-Looping Bug Fix (Attack the Premise)**: Jika 2 kali percobaan perbaikan bug berturut-turut gagal pada tes yang sama, DILARANG mencoba cara ke-3 dengan asumsi yang sama. Berhenti sejenak, tuliskan premis/asumsi dasarnya, dan uji penyebab akar secara independen sebelum menyentuh kode lagi.
- **Eksperimen Mandiri (Empirical Fork / Prototype)**: Jika ada keraguan antara 2 pendekatan teknis, jangan bertanya hal spekulatif ke user. Buat skrip tes kecil / amati perilakunya langsung untuk menentukan pilihan berdasarkan bukti nyata.
- **Scripting over Manual Edits (Build the Lever)**: Jika task menyentuh perubahan pola serupa di >3 file, jangan edit manual satu per satu: buat skrip pembantu / codemod sederhana, jalankan sekaligus, lalu verifikasi via git diff.
- **Source Simbol**: Gunakan `scopecairn read symbol <nama>` alih-alih membaca file penuh.

## 4. Sebelum Menyatakan Selesai (Self-Review & Verification)
1. **Adversarial Self-Review (Interrogate)**: Sebelum melapor selesai, serang kode sendiri:
   - Kasus ekstrem: apakah input null, undefined, kosong, atau sangat besar ditangani dengan aman?
   - Asynchronous & Resource: apakah ada potensi race condition, unhandled rejection, atau resource leak?
   - Kompatibilitas OS: pastikan path separator dan shell command aman di Windows dan Linux.
2. **Prove It Works**:
   - *Bug Fix*: Buktikan dengan test reproduksi (gagal sebelum fix, lulus sesudah fix).
   - *Refactoring*: Buktikan semua test yang ada tetap lulus tanpa memodifikasi assertion test hanya agar hijau.
   - *Feature*: Pastikan tipe/data shape tervalidasi dan ada test verifikasi perilaku.
3. **Verifikasi Akhir**:
   - Jalankan `scopecairn scan` agar indeks ScopeCairn mencerminkan perubahanmu.
   - Cek scope: `scopecairn verify --task "<query>" --strict`
     — membandingkan file yang berubah terhadap scope yang tadi dipakai.
     Kalau ada file di luar Required/Optional, kembalikan ke dalam scope atau minta persetujuan user. Jangan diamkan.
4. **Catat Keputusan**: Ada keputusan arsitektur yang disepakati? Catat sekali: `scopecairn decide "<pilihan> karena <alasan>"` — tersimpan dengan bukti dan ikut terbaca di setiap context berikutnya.
