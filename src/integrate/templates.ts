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
- Bila ternyata lebih dari 2 file harus diubah, panggil ulang konteks penuh:
  \`${prefix} context --escalate "<permintaan user>"\`
- Sebelum mengubah simbol yang dipakai banyak tempat, jalankan:
  \`${prefix} impact <path>\`
- Butuh source sebuah fungsi? Gunakan \`${prefix} read symbol <nama>\`
  alih-alih membaca file penuh.

## Setelah selesai
Jalankan \`${prefix} scan\` agar indeks ScopeCairn mencerminkan perubahanmu.

## Pengecualian
Lewati ScopeCairn hanya untuk pertanyaan non-coding.
`;
}

// Skill Claude (project skill + plugin skill): frontmatter dibatasi field
// spec Agent Skills agar portabel (skills.sh, claude.ai upload). Pemicu
// ditulis di description (batas listing 1536 char). allowed-tools: Bash
// memberi pra-persetujuan bash selama giliran skill (docs/skills).
export function claudeSkillMd(prefix: string): string {
  return `---
name: scopecairn
description: ScopeCairn codebase context + scope. Use for ALL coding tasks
  (feature, bugfix, refactor, code questions) before exploring the repo,
  and when the user says "scopecairn", asks for a repo overview, or asks
  to set up ScopeCairn.
allowed-tools: Bash
---

# ScopeCairn

1. Jika \`.scopecairn/scopecairn.db\` belum ada: jalankan \`${prefix} init\`
   (bila CLI belum ada: \`npm install -g scopecairn\`), laporkan file/simbol/relasi, berhenti.
2. Jika sudah ada: jalankan \`${prefix} context "<task user>"\`.
   Mulai dari Relevant Files. Jangan menjelajah dari nol.
3. Ubah hanya Required/Optional; Protected perlu persetujuan user.
   Simbol bersama → \`${prefix} impact <path>\`.
   Butuh isi fungsi → \`${prefix} read symbol <nama>\`, bukan baca file penuh.
4. Task membesar (>2 file)? Panggil ulang \`${prefix} context --escalate\`.
5. Setelah mengedit: \`${prefix} scan\`. Berhenti saat acceptance criteria terpenuhi.
`;
}

// Aturan generik untuk file merge lain (copilot, dsb).
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
5. Setelah mengedit, jalankan \`${prefix} scan\` agar indeks ScopeCairn mutakhir.
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

// OpenCode custom command (docs/commands): `.opencode/commands/*.md`
// dengan frontmatter + $ARGUMENTS. AGENTS.md tetap dibaca OpenCode (docs/rules).
export function opencodeCommandMd(prefix: string): string {
  return `---
description: ScopeCairn codebase context + scope for a task
---

Run \`${prefix} context "$ARGUMENTS"\` with the bash tool, then:

1. Use Relevant Files as the starting point — do not explore from zero.
2. Change only Required and Optional files; Protected needs user approval.
3. If shared symbols change, run \`${prefix} impact <path>\`.
4. Need a function body? Use \`${prefix} read symbol <nama>\`, not full reads.
5. After editing, run \`${prefix} scan\` so the ScopeCairn index stays fresh.
<!-- scopecairn:managed -->
`;
}

// Snippet izin opencode.json (docs/permissions). DICETAK, tidak ditulis
// otomatis: opencode.json adalah JSONC (boleh berkomentar) dan milik user —
// merge otomatis berisiko merusak konfigurasi yang ada.
export function opencodePermissionGuide(prefix: string): string {
  const rules = ALLOWLIST_COMMANDS.map(
    (c) => `      "${prefix} ${c} *": "allow"`
  ).join(",\n");
  return (
    `Agar command di atas jalan tanpa persetujuan, gabungkan ke opencode.json\n` +
    `(project root atau ~/.config/opencode/opencode.json):\n\n` +
    `{\n  "permission": {\n    "bash": {\n${rules}\n    }\n  }\n}\n\n` +
    `Catatan: ScopeCairn tidak mengubah opencode.json Anda secara otomatis.`
  );
}

// Skill khusus knowledge agent (explain/summarize/audit — read-only).
// Satu body untuk semua agent supaya salinan tidak menyimpang; hanya varian
// "claude" yang memuat `allowed-tools` (grant spesifik Agent Skills Claude,
// bukan field spec skill di tool lain).
export function knowledgeSkillMd(
  prefix: string,
  variant: "portable" | "claude" = "portable"
): string {
  const tools = variant === "claude" ? "allowed-tools: Bash\n" : "";
  return `---
name: scopecairn-knowledge
description: ScopeCairn cold-start map + context extraction for knowledge tasks —
  explain, summarize, document, audit, "how does X work", "why is it like this",
  architecture overview, ownership or bus factor. Read-only — never for code changes.
${tools}---

# ScopeCairn — Knowledge Mode (ReAct)

Reasoning loop: Thought → Action → Observe, max 3 iterasi. Semua Action
read-only terhadap source; ScopeCairn hanya menulis ke \`.scopecairn/\`.

Iteration 0 — Cold start (lewati yang tidak ada):
Thought: apa yang sudah diketahui repo ini tanpa query apa pun?
Action: baca berurutan:
- \`.scopecairn/GRAPH.md\` — peta graph berbudget: modul, simbol paling dipakai,
  hotspot PageRank, siklus, rute, model, protected.
- \`.scopecairn/ARCHAEOLOGY.md\` — kepemilikan/bus factor/churn dari git log lokal
  (snapshot sekali tulis; hapus file untuk regenerasi).
- \`.scopecairn/decisions.md\` — keputusan arsitektur yang tercatat, bila ada.
Observe freshness: GRAPH.md memuat baris
\`> Freshness: scanned <ISO> · HEAD <sha>\` (bila tidak ada — mis. index lama —
lewati cek ini). Bila ada, bandingkan <sha> dengan \`git rev-parse --short HEAD\`;
bila berbeda, sebut peta mungkin usang dan percayai command live untuk yang
berubah. Cold start = orientasi, bukan jawaban.

Iteration 1 — Scope:
Thought: apa yang sebenarnya ditanyakan?
Action: \`${prefix} context --knowledge "<pertanyaan user>" --json\`
Observe: cek \`high\`, \`medium\`, \`symbols[0].score\`, \`analogs\`, \`empty\`.
- \`high\` DAN \`medium\` kosong / semua score <0.15 → reformulasi sekali (alias
  domain dari \`.scopecairn/glossary.yml\`, pecah jadi 2 sub-pertanyaan), lalu
  lanjut dari cold start — jangan berhenti.
- \`high\` kosong tapi \`medium\` berisi → normal untuk task SIMPLE; lanjut.
- \`analogs\` = commit yang menyentuh area sama: bukti "kenapa". Kutip
  \`shortSha + subject\`.
- Keputusan arsitektur: pada output markdown sudah terlampir di akhir
  (\`## Keputusan Arsitektur\`); pada \`--json\` baca \`.scopecairn/decisions.md\`
  langsung (envelope JSON tidak memuatnya).

Iteration 2 — Expand:
Thought: simbol mana yang perlu trace relasi?
Action (pilih seperlunya, selalu \`--json\`):
- Relasi modul: \`${prefix} graph <symbol> --json\`
- Dampak: \`${prefix} impact <path> --json\`
- Alur A→B: \`${prefix} graph <from> --to <to> --json\`
Observe: sambungkan hop via \`edges[].rel\` (\`graph\`) atau \`hops[].rel\`
(\`graph --to\`) — rel CALLS/IMPORTS/QUERIES.
Stop bila rantai sudah menjawab "kenapa / bagaimana".

Iteration 3 — Ground:
Thought: apa bukti historis / source-nya?
Action:
- \`${prefix} history "<pertanyaan>" --json\` untuk keputusan + co-change
  (\`empty: true\` = tidak ada analog — jangan dipaksa).
- \`${prefix} read symbol <nama> --json\` untuk excerpt (bukan baca file penuh).
Observe: kutip \`shortSha + subject\` dan \`file:range\` sebagai bukti.

Stop rules: berhenti saat jawaban cukup, atau 3 iterasi, atau \`high\` stabil
antar iterasi. Bentuk jawaban: jawaban dulu, lalu bukti (\`file:line\`,
\`shortSha + subject\`), lalu pertanyaan terbuka. Setiap klaim butuh bukti dari
command di atas — artefak cold start adalah orientasi, bukan bukti per-task.
Jangan menulis atau mengubah file — hanya baca, rangkum, dan jelaskan.
`;
}

// Perintah aman untuk allowlist (AI-8: read-only terhadap source,
// hanya menulis ke `.scopecairn/`). `history` ikut walau alias tersembunyi —
// skill knowledge memakainya untuk bukti "kenapa".
export const ALLOWLIST_COMMANDS = [
  "context",
  "impact",
  "read",
  "graph",
  "history",
  "status",
  "verify",
] as const;

export const MANUAL_ONLY_COMMANDS = ["init", "scan"] as const;

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
