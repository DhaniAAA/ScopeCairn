// Template tiga lapisan auto-invocation (PRD §8.3). `{prefix}` diisi
// `scopecairn` atau `npx scopecairn` oleh init agar identik di semua
// lapisan + allowlist (AI-9).

export const MARKER = "<!-- scopecairn:managed -->";

function ruleBody(prefix: string): string {
  return `# ScopeCairn — Protokol Engineering Otomatis

## 1. Sikap Kerja Otomatis (Anti-Slop & Laziness Protocol)
Patuhi prinsip ini di setiap baris kode secara otomatis tanpa perlu diminta user:
- **Laziness Protocol (Minimal Diff)**: Buat perubahan sekecil mungkin yang menyelesaikan masalah. Prioritaskan penghapusan kode (bias to deletion). Dilarang membuat layer abstraksi, wrapper, atau interface tambahan yang tidak diminta.
- **Anti-AI Slop**: Hapus komentar naratif yang menceritakan langkah kerja (seperti \`// Step 1: add x\`, \`// Phase 2\`). Kode harus mendokumentasikan dirinya sendiri melalui penamaan fungsi, tipe yang presisi, dan assertions. Hindari gaya tulisan AI klise/basa-basi.
- **Boundary & Type Discipline**: Validasi ketat di perbatasan sistem (I/O, argumen CLI, API), dan pertahankan core logic tetap murni (pure functions).
- **Perlindungan Konteks Historis (Why Guard)**: Jangan menghapus kode penanganan kasus khusus yang tampak janggal sebelum mengecek git history/blame, agar tidak membangkitkan bug lama.

## 2. Inisialisasi Task & Pemanggilan Context
- **Cold start**: Jika \`.scopecairn/scopecairn.db\` belum ada di repository, jalankan \`${prefix} init\` terlebih dahulu untuk memetakan codebase.
- **Jalankan \`${prefix} context "<query>"\` HANYA JIKA**:
  1. Memulai fitur baru / bugfix yang belum diketahui letak file dan simbolnya di codebase.
  2. Ingin menetapkan scope pengeditan untuk verifikasi.
- **LEWATI \`${prefix} context\` JIKA**:
  1. User sudah menyebutkan target file atau fungsinya secara spesifik (misal: "perbaiki bug di src/retrieval/tokenize.ts"). Agent bisa langsung membaca simbol/file tersebut tanpa search context.
  2. Pertanyaan berupa diskusi konseptual, code review, arsitektur, atau sekadar tanya jawab.
  3. Melanjutkan percakapan dalam sesi yang sama di mana scope file sudah diketahui.
- **Ekstraksi Query**: Jika prompt user panjang atau berupa spesifikasi kompleks, jangan masukkan seluruh paragraf ke terminal. Ambil 2–4 kata kunci teknis utama (nama modul, entitas, aksi) sebagai argumen context untuk mencari file jangkar (anchor), sementara detail spesifikasi lengkap tetap diikuti langsung dari prompt user.

Gunakan hasilnya sebagai titik awal. Jangan menjelajah repository dari nol.

## 3. Selama Pengerjaan
- **Batas Scope**: Ubah hanya file di daftar Required dan Optional. Jangan sentuh file di daftar Protected tanpa persetujuan user. Bila ternyata lebih dari 2 file harus diubah, panggil ulang: \`${prefix} context --escalate "<query>"\`.
- **Blast Radius & Safety Fact**: Sebelum mengubah simbol/file yang dipakai banyak tempat (fan-in tinggi):
  1. Jalankan \`${prefix} impact <path>\` untuk melihat pemanggil dan tes terdampak.
  2. Rumuskan 1 fakta penjamin keamanan (*the one safety fact it is safe because of*).
  3. Buktikan fakta tersebut dengan menjalankan tes terkait (\`${prefix} impact <path> --run-tests\` atau test runner) sebelum lanjut.
- **Anti-Looping Bug Fix (Attack the Premise)**: Jika 2 kali percobaan perbaikan bug berturut-turut gagal pada tes yang sama, DILARANG mencoba cara ke-3 dengan asumsi yang sama. Berhenti sejenak, tuliskan premis/asumsi dasarnya, dan uji penyebab akar secara independen sebelum menyentuh kode lagi.
- **Eksperimen Mandiri (Empirical Fork / Prototype)**: Jika ada keraguan antara 2 pendekatan teknis, jangan bertanya hal spekulatif ke user. Buat skrip tes kecil / amati perilakunya langsung untuk menentukan pilihan berdasarkan bukti nyata.
- **Scripting over Manual Edits (Build the Lever)**: Jika task menyentuh perubahan pola serupa di >3 file, jangan edit manual satu per satu: buat skrip pembantu / codemod sederhana, jalankan sekaligus, lalu verifikasi via git diff.
- **Source Simbol**: Gunakan \`${prefix} read symbol <nama>\` alih-alih membaca file penuh.

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
   - Jalankan \`${prefix} scan\` agar indeks ScopeCairn mencerminkan perubahanmu.
   - Cek scope: \`${prefix} verify --task "<query>" --strict\`
     — membandingkan file yang berubah terhadap scope yang tadi dipakai.
     Kalau ada file di luar Required/Optional, kembalikan ke dalam scope atau minta persetujuan user. Jangan diamkan.
4. **Catat Keputusan**: Ada keputusan arsitektur yang disepakati? Catat sekali: \`${prefix} decide "<pilihan> karena <alasan>"\` — tersimpan dengan bukti dan ikut terbaca di setiap context berikutnya.
`;
}

// Skill Claude (project skill + plugin skill): frontmatter dibatasi // spec Agent Skills agar portabel (skills.sh, claude.ai upload). Pemicu
// ditulis di description (batas listing 1536 char). allowed-tools: Bash
// memberi pra-persetujuan bash selama giliran skill (docs/skills).
export function claudeSkillMd(prefix: string): string {
  return `---
name: scopecairn
description: ScopeCairn codebase context + scope + engineering rigor. Use for coding tasks
  (feature, bugfix, refactor) when target files are unknown or to enforce scope,
  and when the user says "scopecairn", asks for a repo overview, or asks
  to set up ScopeCairn.
allowed-tools: Bash
---

${ruleBody(prefix)}`;
}

// Aturan generik untuk file merge lain (copilot, dsb).
export function genericRuleMd(prefix: string): string {
  return `${MARKER}\n${ruleBody(prefix)}`;
}

// Cursor memakai frontmatter .mdc agar selalu diterapkan.
export function cursorRuleMdc(prefix: string): string {
  return `---
description: ScopeCairn codebase rules — panggil scopecairn context saat file target belum diketahui
alwaysApply: true
---

${MARKER}
${ruleBody(prefix)}`;
}

export function skillMd(prefix: string): string {
  return `---
name: scopecairn
description: ScopeCairn codebase context + scope + engineering rigor. Gunakan untuk task coding bila letak file belum diketahui atau untuk menetapkan scope verifikasi.
---

${ruleBody(prefix)}`;
}

export function workflowMd(prefix: string): string {
  return `# /scopecairn

Shortcut manual bila agent lupa menjalankan protokol otomatis ScopeCairn.

Prinsip Otomatis:
- Laziness Protocol (diff minimal, no slop, dilarang menambah layer abstraksi baru).
- Blast Radius: Simbol bersama wajib impact + safety fact + buktikan dengan tes.
- Anti-Looping: 2x gagal perbaiki bug pada tes yang sama → dilarang coba cara ke-3 dengan asumsi serupa; serang premis dasar secara independen.
- Prove It Works: Selalu buktikan perbaikan/fitur dengan tes nyata sebelum menyatakan selesai.

Langkah Alur Kerja:
1. Jika prompt user panjang/kompleks, ambil 2–4 kata kunci teknis utama sebagai argumen context.
2. Jalankan \`${prefix} context "<kata kunci teknis>"\` (jika file target belum diketahui atau untuk mengunci scope).
3. Ikuti Relevant Files dan Task Scope (Required & Optional; dilarang sentuh Protected tanpa izin).
4. Perlu periksa dampak perubahan? \`${prefix} impact <path> --run-tests\`.
5. Perlu source simbol? \`${prefix} read symbol <nama>\`.
6. Keputusan arsitektur disepakati? \`${prefix} decide "<pilihan> karena <alasan>"\`.
7. Sebelum menyatakan selesai:
   - Adversarial self-review: periksa input null/undefined/edge-cases, async race condition, kompatibilitas OS.
   - Buktikan perubahan dengan test nyata.
   - Jalankan \`${prefix} scan\`, lalu \`${prefix} verify --task "<kata kunci teknis>" --strict\`
     — memastikan file yang diubah tidak bocor ke luar scope.
`;
}

// OpenCode custom command (docs/commands): \`.opencode/commands/*.md\`
// dengan frontmatter + $ARGUMENTS. AGENTS.md tetap dibaca OpenCode (docs/rules).
export function opencodeCommandMd(prefix: string): string {
  return `---
description: ScopeCairn codebase context + scope + engineering rigor for a task
---

Run \`${prefix} context "$ARGUMENTS"\` with the bash tool (extract 2-4 technical keywords if query is complex), then:

1. Use Relevant Files as the starting point — do not explore from zero.
2. Change only Required and Optional files; Protected needs user approval.
3. If shared symbols change, run \`${prefix} impact <path>\`, formulate one safety fact, and verify with tests.
4. If bug fix fails 2x on the same test, stop and attack the premise independently before attempting a 3rd time.
5. Need a function body? Use \`${prefix} read symbol <nama>\`, not full reads.
6. Before finishing: perform adversarial self-review, ensure real tests pass, run \`${prefix} scan\`, then run \`${prefix} verify --task "$ARGUMENTS" --strict\` to catch out-of-scope files.
7. Settled an architectural decision? Record it once: \`${prefix} decide "<choice> because <why>"\`.
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
- \`.scopecairn/decisions.md\` — keputusan arsitektur yang tercatat (dicatat
  user/agent lewat \`${prefix} decide\`), bila ada.
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

// `decide` sengaja TIDAK masuk allowlist: isinya prosa yang ikut disuntikkan
// ke setiap prompt `context` berikutnya, jadi agent tidak boleh menulisnya
// tanpa persetujuan user per panggilan.
export const MANUAL_ONLY_COMMANDS = ["init", "scan", "decide"] as const;

export function allowlistGuide(prefix: string): string {
  const lines = ALLOWLIST_COMMANDS.map((c) => `  ${prefix} ${c}`);
  return (
    `Agar agent dapat memakai ScopeCairn tanpa persetujuan per panggilan,\n` +
    `tambahkan entri berikut ke Terminal Allow List Antigravity\n` +
    `(Settings → Advanced Settings → Terminal):\n\n` +
    lines.join("\n") +
    `\n\nCatatan: ScopeCairn tidak mengubah pengaturan IDE Anda secara otomatis.\n` +
    `\`decide\` sengaja tidak ada di daftar: isinya terbaca di setiap context\n` +
    `berikutnya, jadi biarkan lewat persetujuan Anda per panggilan.`
  );
}
