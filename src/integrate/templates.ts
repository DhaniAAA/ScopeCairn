// Template tiga lapisan auto-invocation (PRD §8.3). `{prefix}` diisi
// `scopecairn` atau `npx scopecairn` oleh init agar identik di semua
// lapisan + allowlist (AI-9).

export const MARKER = "<!-- scopecairn:managed -->";

function ruleBody(prefix: string): string {
  return `# ScopeCairn

## Wajib untuk setiap task coding
Sebelum membaca file atau menjalankan grep, jalankan:

    ${prefix} context "<permintaan user>"

Gunakan hasilnya sebagai titik awal. Jangan menjelajah repository dari nol.

## Selama bekerja
- Ubah hanya file di daftar Required dan Optional.
- Jangan sentuh file di daftar Protected tanpa persetujuan user.
- Sebelum mengubah simbol yang dipakai banyak tempat, jalankan:
  \`${prefix} impact <path>\`
- Butuh source sebuah fungsi? Gunakan \`${prefix} read symbol <nama>\`
  alih-alih membaca file penuh.

## Pengecualian
Lewati ScopeCairn hanya untuk pertanyaan non-coding.
`;
}

export function agentsMd(prefix: string): string {
  return `${MARKER}\n${ruleBody(prefix)}`;
}

// Aturan generik untuk file merge lain (CLAUDE.md, GEMINI.md, copilot).
export function genericRuleMd(prefix: string): string {
  return `${MARKER}\n${ruleBody(prefix)}`;
}

// Cursor memakai frontmatter .mdc agar selalu diterapkan.
export function cursorRuleMdc(prefix: string): string {
  return `---
description: ScopeCairn codebase rules — panggil scopecairn context di tiap task coding
alwaysApply: true
---

${MARKER}
${ruleBody(prefix)}`;
}

export function skillMd(prefix: string): string {
  return `---
name: scopecairn
description: Gunakan untuk SEMUA task coding (fitur baru, bug fix, refactor,
  pertanyaan tentang kode) sebelum menjelajah repository.
---

Langkah:
1. Jalankan \`${prefix} context "<permintaan user>"\`.
2. Baca bagian Relevant Files dan Task Scope.
3. Jika ada perubahan pada simbol bersama, jalankan \`${prefix} impact <path>\`.
4. Kerjakan task sesuai scope, lalu berhenti saat selesai.
`;
}

export function workflowMd(prefix: string): string {
  return `# /scopecairn

Shortcut manual bila agent lupa memanggil ScopeCairn otomatis.

1. Jalankan \`${prefix} context "<permintaan user>"\`.
2. Ikuti Relevant Files dan Task Scope dari output.
3. Perlu dampak perubahan? \`${prefix} impact <path>\`.
4. Perlu source simbol? \`${prefix} read symbol <nama>\`.
`;
}

// Perintah aman untuk allowlist (AI-8: read-only terhadap source,
// hanya menulis ke `.scopecairn/`).
export const ALLOWLIST_COMMANDS = [
  "context",
  "impact",
  "read",
  "query",
  "graph",
  "status",
  "doctor",
] as const;

export const MANUAL_ONLY_COMMANDS = ["init", "scan", "rebuild", "clean"] as const;

export function allowlistGuide(prefix: string): string {
  const lines = ALLOWLIST_COMMANDS.map((c) => `  ${prefix} ${c}`);
  return (
    `Agar agent dapat memakai ScopeCairn tanpa persetujuan per panggilan,\n` +
    `tambahkan entri berikut ke Terminal Allow List Antigravity\n` +
    `(Settings → Advanced Settings → Terminal):\n\n` +
    lines.join("\n") +
    `\n\nCatatan: ScopeCairn tidak mengubah pengaturan IDE Anda secara otomatis.`
  );
}
