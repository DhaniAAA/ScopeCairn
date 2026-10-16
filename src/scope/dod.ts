import type { DatabaseSync } from "node:sqlite";
import { DEFINITION_OF_DONE } from "./guard.js";

// Penilai Definition of Done (PRD §15). Hanya item yang benar-benar bisa
// diverifikasi mesin yang diberi status pass/warn/fail; sisanya `manual` —
// lebih baik mengaku tak tahu daripada mengklaim "done".
export type DodStatus = "pass" | "warn" | "fail" | "manual";

export interface DodCheck {
  item: string;
  status: DodStatus;
  detail: string;
}

export interface DodInput {
  changedFiles: string[];
  /** true bila scope task diketahui (verify dipanggil dengan --task). */
  scopeChecked: boolean;
  scopeViolations: string[];
  affectedTests: string[];
  /** true bila index sudah di-refresh pada invokasi ini. */
  indexRefreshed: boolean;
}

const MANUAL = "penilaian agent/user — tidak dapat diverifikasi otomatis";

type Rule = (input: DodInput) => { status: DodStatus; detail: string };

const RULES: Record<string, Rule> = {
  "Fungsionalitas yang diminta terimplementasi": () => ({ status: "manual", detail: MANUAL }),

  "Test relevan lulus": (i) => {
    if (i.changedFiles.length === 0) {
      return { status: "manual", detail: "tidak ada file berubah — tidak ada test untuk diverifikasi" };
    }
    if (i.affectedTests.length === 0) {
      return { status: "warn", detail: "tidak ada test terkait terdeteksi untuk perubahan ini" };
    }
    const shown = i.affectedTests.slice(0, 5).join(", ");
    const more = i.affectedTests.length > 5 ? `, +${i.affectedTests.length - 5} lainnya` : "";
    return {
      status: "manual",
      detail: `belum dijalankan pada invokasi ini: ${shown}${more} (atau \`scopecairn impact <target> --run-tests\`)`,
    };
  },

  "Tidak ada file berubah tanpa alasan": (i) => {
    if (!i.scopeChecked) {
      return { status: "manual", detail: "jalankan dengan --task \"<task>\" untuk memeriksa scope" };
    }
    if (i.scopeViolations.length === 0) {
      return { status: "pass", detail: `semua ${i.changedFiles.length} file berubah ada di dalam scope` };
    }
    const shown = i.scopeViolations.slice(0, 5).join(", ");
    const more = i.scopeViolations.length > 5 ? `, +${i.scopeViolations.length - 5} lainnya` : "";
    return { status: "fail", detail: `di luar scope: ${shown}${more}` };
  },

  "Tidak ada refactoring tak terkait": () => ({
    status: "manual",
    detail: "periksa `scopecairn verify --diff` (diff struktural per simbol)",
  }),

  "Acceptance criteria terpenuhi": () => ({ status: "manual", detail: MANUAL }),

  "Index dimutakhirkan (`scopecairn scan`)": (i) =>
    i.indexRefreshed
      ? { status: "pass", detail: "index di-refresh pada invokasi ini" }
      : { status: "warn", detail: "dilewati (--no-refresh): jalankan `scopecairn scan` sebelum commit" },
};

/** File test yang relevan bagi file yang berubah. */
export function isTestPath(p: string): boolean {
  return (
    p.includes(".test.") ||
    p.includes(".spec.") ||
    p.includes("__tests__") ||
    (p.split("/").pop() ?? "").startsWith("test_")
  );
}

/**
 * Test terdampak dari file yang berubah. Edge `TESTS` berarah test -> file
 * yang diuji (lihat `linkTests`), jadi test dicari di sisi source ketika sisi
 * target yang berubah. File test yang ikut berubah selalu dihitung.
 */
export function collectAffectedTests(db: DatabaseSync, changedFiles: string[]): string[] {
  if (changedFiles.length === 0) return [];
  const out = new Set<string>();
  const ph = changedFiles.map(() => "?").join(",");
  try {
    const rows = db
      .prepare(
        `SELECT DISTINCT f1.path AS t
         FROM relationships r
         JOIN symbols s1 ON s1.id = r.source_id
         JOIN symbols s2 ON s2.id = r.target_id
         JOIN files f1 ON f1.id = s1.file_id
         JOIN files f2 ON f2.id = s2.file_id
         WHERE r.relationship_type = 'TESTS' AND f2.path IN (${ph})`
      )
      .all(...changedFiles) as { t: string }[];
    for (const r of rows) out.add(r.t.replace(/\\/g, "/"));
  } catch {
    // skema lama tanpa tabel graf — abaikan
  }
  for (const c of changedFiles) if (isTestPath(c)) out.add(c.replace(/\\/g, "/"));
  return [...out].sort();
}

export function evaluateDod(
  input: DodInput,
  items: readonly string[] = DEFINITION_OF_DONE
): DodCheck[] {
  return items.map((item) => {
    const rule = RULES[item];
    if (!rule) return { item, status: "manual" as const, detail: "tidak dapat diverifikasi otomatis" };
    const { status, detail } = rule(input);
    return { item, status, detail };
  });
}

/** true bila ada item yang gagal — `warn` dan `manual` tidak menggagalkan commit. */
export function dodFailed(checks: DodCheck[]): boolean {
  return checks.some((c) => c.status === "fail");
}

const MARK: Record<DodStatus, string> = { pass: "✓", warn: "!", fail: "✗", manual: " " };

export function renderDod(checks: DodCheck[]): string {
  const lines = ["## Definition of Done"];
  for (const c of checks) lines.push(`- [${MARK[c.status]}] ${c.item} — ${c.detail}`);
  const count = (s: DodStatus): number => checks.filter((c) => c.status === s).length;
  lines.push(
    `\nRingkasan: ${count("pass")} pass, ${count("warn")} warn, ${count("fail")} fail, ${count("manual")} manual`
  );
  return lines.join("\n");
}
