<!-- scopecairn:managed -->
# ScopeCairn

## Wajib untuk setiap task coding
Sebelum membaca file atau menjalankan grep, jalankan:

    scopecairn context "<permintaan user>"

Gunakan hasilnya sebagai titik awal. Jangan menjelajah repository dari nol.

## Selama bekerja
- Ubah hanya file di daftar Required dan Optional.
- Jangan sentuh file di daftar Protected tanpa persetujuan user.
- Sebelum mengubah simbol yang dipakai banyak tempat, jalankan:
  `scopecairn impact <path>`
- Butuh source sebuah fungsi? Gunakan `scopecairn read symbol <nama>`
  alih-alih membaca file penuh.

## Pengecualian
Lewati ScopeCairn hanya untuk pertanyaan non-coding.
