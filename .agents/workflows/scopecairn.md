# /scopecairn

Shortcut manual bila agent lupa menjalankan protokol otomatis ScopeCairn.

Prinsip Otomatis:
- Laziness Protocol (diff minimal, no slop, dilarang menambah layer abstraksi baru).
- Blast Radius: Simbol bersama wajib impact + safety fact + buktikan dengan tes.
- Anti-Looping: 2x gagal perbaiki bug pada tes yang sama → dilarang coba cara ke-3 dengan asumsi serupa; serang premis dasar secara independen.
- Prove It Works: Selalu buktikan perbaikan/fitur dengan tes nyata sebelum menyatakan selesai.
- Transparansi Status: Awali respon dengan 1 baris penanda scope, misal: `> 🧭 [ScopeCairn: ...]`.

Langkah Alur Kerja:
1. Jika prompt user panjang/kompleks, ambil 2–4 kata kunci teknis utama sebagai argumen context.
2. Jalankan `scopecairn context "<kata kunci teknis>"` (jika file target belum diketahui atau untuk mengunci scope).
3. Ikuti Relevant Files dan Task Scope (Required & Optional; dilarang sentuh Protected tanpa izin).
4. Perlu periksa dampak perubahan? `scopecairn impact <path> --run-tests`.
5. Perlu source simbol? `scopecairn read symbol <nama>`.
6. Keputusan arsitektur disepakati? `scopecairn decide "<pilihan> karena <alasan>"`.
7. Sebelum menyatakan selesai:
   - Adversarial self-review: periksa input null/undefined/edge-cases, async race condition, kompatibilitas OS.
   - Buktikan perubahan dengan test nyata.
   - Jalankan `scopecairn scan`, lalu `scopecairn verify --task "<kata kunci teknis>" --strict`
     — memastikan file yang diubah tidak bocor ke luar scope.
