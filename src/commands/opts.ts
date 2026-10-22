/**
 * Normalisasi flag bersama untuk handler command.
 *
 * Commander v12 memetakan `--no-refresh` ke `{ refresh: false }` — bukan
 * `{ noRefresh: true }`. Karena itu handler harus memeriksa KEDUA bentuk:
 * bentuk `noRefresh` dipakai saat fungsi dipanggil langsung (test, API
 * internal), bentuk `refresh === false` dipakai saat argumen datang dari CLI.
 *
 * Fungsi ini dipusatkan supaya tiap handler tidak harus mengingat aturan itu —
 * dulu 4 dari 5 situs lupa dan `--no-refresh` diam-diam tidak influential.
 */

/** Opsi refresh dalam bentuk apa pun yang mungkin diterima. */
export interface RefreshFlags {
  noRefresh?: boolean;
  refresh?: boolean;
}

/**
 * True bila refresh indeks harus dilewati.
 * Benar bila flag passed secara langsung (`noRefresh: true`) maupun via
 * Commander (`--no-refresh` → `refresh: false`).
 */
export function skipRefresh(opts: RefreshFlags | undefined): boolean {
  if (!opts) return false;
  return opts.noRefresh === true || opts.refresh === false;
}