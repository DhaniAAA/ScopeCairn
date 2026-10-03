// Task Guard & Definition of Done (PRD §15): aturan kerja minimal.
// Sengaja ringkas — setiap baris token yang dibayar agent di tiap task.

export const TASK_GUARD_RULES = [
  "Ubah hanya file Required dan Optional; Protected perlu persetujuan user.",
  "Jangan refactor, upgrade dependency, atau abstraksi prematur yang tak diminta.",
  "Jangan tulis ulang kode berjalan; jangan tambah file/komentar tak perlu.",
  "Berhenti saat acceptance criteria terpenuhi.",
] as const;

export const DEFINITION_OF_DONE = [
  "Fungsionalitas yang diminta terimplementasi",
  "Test relevan lulus",
  "Tidak ada file berubah tanpa alasan",
  "Tidak ada refactoring tak terkait",
  "Acceptance criteria terpenuhi",
] as const;

export function guardBlock(): string {
  return (
    `## Task Guard\n${TASK_GUARD_RULES.map((r) => `- ${r}`).join("\n")}\n\n` +
    `## Definition of Done\n${DEFINITION_OF_DONE.map((d) => `- [ ] ${d}`).join("\n")}\n`
  );
}
