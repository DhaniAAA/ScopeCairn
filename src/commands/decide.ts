import { appendDecision, listDecisions } from "../decisions.js";

// `decide` (PRD §15, pasangan Task Guard): keputusan arsitektur yang dicatat
// sekali ikut terbawa ke setiap `context` berikutnya — menggantikan kebiasaan
// menulis manual di .scopecairn/decisions.md.
export interface DecideOptions {
  json?: boolean;
}

export type DecideResult =
  | { mode: "list"; entries: string[] }
  | { mode: "added"; entry: string }
  | { mode: "error"; message: string };

export function runDecide(repoRoot: string, text?: string): DecideResult {
  if (text === undefined) {
    return { mode: "list", entries: listDecisions(repoRoot) };
  }
  if (text.trim().length === 0) {
    return { mode: "error", message: "teks keputusan kosong" };
  }
  try {
    appendDecision(repoRoot, text);
  } catch (err) {
    return { mode: "error", message: err instanceof Error ? err.message : String(err) };
  }
  const entries = listDecisions(repoRoot);
  return { mode: "added", entry: entries[entries.length - 1] ?? "" };
}

export function cmdDecide(
  repoRoot: string,
  text: string | undefined,
  opts: DecideOptions = {}
): void {
  const res = runDecide(repoRoot, text);

  if (opts.json) {
    if (res.mode === "error") {
      console.log(JSON.stringify({ error: res.message }, null, 2));
      process.exitCode = 1;
      return;
    }
    console.log(JSON.stringify(res, null, 2));
    return;
  }

  if (res.mode === "error") {
    console.error(`✗ ${res.message}`);
    console.error(`Gunakan: scopecairn decide "pilihan X karena Y"`);
    process.exitCode = 1;
    return;
  }

  if (res.mode === "added") {
    console.log(`✓ Keputusan dicatat: ${res.entry}`);
    console.log("Ikut terbaca di `scopecairn context` berikutnya.");
    return;
  }

  if (res.entries.length === 0) {
    console.log("Belum ada keputusan arsitektur.");
    console.log(`Catat dengan: scopecairn decide "pilihan X karena Y"`);
    return;
  }

  console.log(`# Keputusan Arsitektur (.scopecairn/decisions.md)\n`);
  for (const e of res.entries) console.log(e);
  console.log(`\n${res.entries.length} keputusan — semuanya ikut terbaca di \`scopecairn context\`.`);
}
