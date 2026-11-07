import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { scanRepository } from "../src/scanner.js";
import { openDb } from "../src/db.js";
import { searchReuse, parseSignatureHint, cmdReuse } from "../src/commands/reuse.js";
import { findDeadCode, cmdDead } from "../src/commands/dead.js";

function createFixtureProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sc-reuse-dead-"));

  // package.json dengan main, bin, dan exports
  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify(
      {
        name: "fixture-app",
        version: "1.0.0",
        main: "dist/index.js",
        bin: {
          "fixture-cli": "dist/cli.js",
        },
        exports: {
          ".": "./dist/index.js",
          "./public-api": "./dist/publicApi.js",
        },
      },
      null,
      2
    ),
    "utf8"
  );

  fs.mkdirSync(path.join(dir, "src", "app", "api", "users"), { recursive: true });
  fs.mkdirSync(path.join(dir, "migrations"), { recursive: true });
  fs.mkdirSync(path.join(dir, "tests"), { recursive: true });

  // 1. Entrypoint main (`src/index.ts`) — memanggil formatCurrency & UserValidator
  fs.writeFileSync(
    path.join(dir, "src", "index.ts"),
    `import { formatCurrency, UserValidator } from "./utils.js";

export function bootstrapApp(amount: number): string {
  const validator = new UserValidator();
  if (!validator.isValid("admin")) return "invalid";
  return formatCurrency(amount, "IDR");
}
`,
    "utf8"
  );

  // 2. Entrypoint bin (`src/cli.ts`) — tidak dipanggil siapa pun tapi dikecualikan via package.json bin
  fs.writeFileSync(
    path.join(dir, "src", "cli.ts"),
    `import { bootstrapApp } from "./index.js";

function runCli(): void {
  console.log(bootstrapApp(50000));
}
runCli();
`,
    "utf8"
  );

  // 3. Entrypoint exports (`src/publicApi.ts`) — dikecualikan via package.json exports
  fs.writeFileSync(
    path.join(dir, "src", "publicApi.ts"),
    `export function externalSdkEntry(token: string): boolean {
  return token.length > 10;
}
`,
    "utf8"
  );

  // 4. `src/utils.ts` — berisi:
  //    - `formatCurrency` (dipakai di index.ts, punya doc comment & call graph neighbor `roundCents`)
  //    - `roundCents` (helper internal yang dipanggil `formatCurrency`)
  //    - `unusedLocalHelper` (dead code HIGH: fungsi lokal tidak di-export dan tidak pernah dipanggil)
  //    - `unusedExportedFormatter` (dead code MEDIUM: fungsi di-export tapi tidak ada pemakai)
  //    - `UserValidator` (class dipakai di index.ts, punya method `unusedMethod` -> dead code LOW)
  fs.writeFileSync(
    path.join(dir, "src", "utils.ts"),
    `function roundCents(val: number): number {
  return Math.round(val * 100) / 100;
}

/**
 * Format nominal uang ke mata uang lokal dengan pembulatan sen.
 */
export function formatCurrency(amount: number, currencyCode: string): string {
  const rounded = roundCents(amount);
  return \`\${currencyCode} \${rounded.toFixed(2)}\`;
}

function unusedLocalHelper(raw: string): string {
  return raw.trim().toLowerCase();
}

export function unusedExportedFormatter(input: string, prefix: string): string {
  return prefix + ":" + input;
}

export class UserValidator {
  isValid(username: string): boolean {
    return username.length >= 3;
  }

  unusedLegacyCheck(role: string): boolean {
    return role === "root";
  }
}
`,
    "utf8"
  );

  // 5. `src/orphanFile.ts` — file yatim penuh (dead code HIGH untuk file & fungsi lokalnya)
  fs.writeFileSync(
    path.join(dir, "src", "orphanFile.ts"),
    `function completelyDeadInternal(): number {
  return 42;
}
`,
    "utf8"
  );

  // 6. Framework route Next.js (`src/app/api/users/route.ts`) — harus dikecualikan oleh `dead`
  fs.writeFileSync(
    path.join(dir, "src", "app", "api", "users", "route.ts"),
    `export async function GET(): Promise<Response> {
  return new Response("ok");
}
`,
    "utf8"
  );

  // 7. Protected file (`migrations/001_init.ts`) — berada di path Protected `migrations/**`, harus dikecualikan
  fs.writeFileSync(
    path.join(dir, "migrations", "001_init.ts"),
    `export function runMigrationUp(): void {}
`,
    "utf8"
  );

  // 8. Test file (`tests/utils.test.ts`) — file test harus dikecualikan dari laporan dead code
  fs.writeFileSync(
    path.join(dir, "tests", "utils.test.ts"),
    `import { formatCurrency } from "../src/utils.js";

function testHelperLocal(): string {
  return formatCurrency(10, "USD");
}
`,
    "utf8"
  );

  return dir;
}

test("parseSignatureHint mengekstrak arity, tipe parameter, dan return type", () => {
  const sig1 = parseSignatureHint("function formatCurrency(amount: number, currencyCode: string): string");
  assert.equal(sig1.hasSignatureSyntax, true);
  assert.equal(sig1.arity, 2);
  assert.deepEqual(sig1.paramTypes, ["number", "string"]);
  assert.equal(sig1.returnType, "string");

  const sig2 = parseSignatureHint("(items: string[]): Promise<boolean>");
  assert.equal(sig2.hasSignatureSyntax, true);
  assert.equal(sig2.arity, 1);
  assert.deepEqual(sig2.paramTypes, ["stringarray"]);
  assert.equal(sig2.returnType, "boolean");

  const noSig = parseSignatureHint("format nominal mata uang");
  assert.equal(noSig.hasSignatureSyntax, false);
  assert.equal(noSig.arity, null);
});

test("scopecairn reuse & dead bekerja akurat pada fixture project (happy path, edge case, exclusions)", async () => {
  const dir = createFixtureProject();
  try {
    await scanRepository(dir);
    const db = openDb(dir);
    try {
      // --- A1: Reuse berdasarkan token nama camelCase & doc comment ---
      const r1 = searchReuse(db, dir, "format currency nominal uang");
      assert.equal(r1.empty, false);
      assert.ok(r1.candidates.length >= 1);
      assert.equal(r1.candidates[0].name, "formatCurrency");
      assert.equal(r1.candidates[0].path, "src/utils.ts");
      assert.equal(r1.candidates[0].exported, true);
      assert.ok(
        r1.candidates[0].reasons.some((r) => r.includes("name tokens")),
        "alasan harus memuat kecocokan token nama"
      );
      assert.ok(
        r1.candidates[0].reasons.some((r) => r.includes("doc comment")),
        "alasan harus memuat kecocokan doc comment"
      );

      // --- A2: Reuse berdasarkan kemiripan signature & call graph neighbor ---
      const r2 = searchReuse(db, dir, "(amount: number, code: string): string roundCents");
      assert.equal(r2.empty, false);
      const top2 = r2.candidates[0];
      assert.equal(top2.name, "formatCurrency");
      assert.ok(
        top2.reasons.some((r) => r.includes("signature") && r.includes("arity=2")),
        "alasan harus memuat kecocokan arity signature"
      );
      assert.ok(
        top2.reasons.some((r) => r.includes("call-graph neighbors") && r.includes("roundCents")),
        "alasan harus memuat tetangga call graph roundCents"
      );

      // --- A3: Reuse hasil kosong & string kosong tidak melempar error ---
      const rEmpty = searchReuse(db, dir, "quantum entanglement matrix solver");
      assert.equal(rEmpty.empty, true);
      assert.deepEqual(rEmpty.candidates, []);

      const rBlank = searchReuse(db, dir, "   ");
      assert.equal(rBlank.empty, true);
      assert.deepEqual(rBlank.candidates, []);

      // --- B1: Dead code melaporkan node tanpa edge masuk dengan confidence yang tepat ---
      const dead = findDeadCode(db, dir);
      const names = new Map(dead.findings.map((f) => [`${f.type}:${f.name}`, f]));

      // High confidence: fungsi lokal tak terpakai & file yatim
      const localDead = names.get("function:unusedLocalHelper");
      assert.ok(localDead, "unusedLocalHelper harus terdeteksi sebagai dead code");
      assert.equal(localDead.confidence, "high");
      assert.equal(localDead.exported, false);

      const orphanFile = names.get("file:src/orphanFile.ts");
      assert.ok(orphanFile, "src/orphanFile.ts harus terdeteksi sebagai dead file");
      assert.equal(orphanFile.confidence, "high");

      // Medium confidence: fungsi yang di-export tetapi tidak pernah dipanggil di repo
      const exportedDead = names.get("function:unusedExportedFormatter");
      assert.ok(exportedDead, "unusedExportedFormatter harus terdeteksi sebagai dead code");
      assert.equal(exportedDead.confidence, "medium");
      assert.equal(exportedDead.exported, true);

      // Low confidence: method class tanpa pemanggil statis (rawan polimorfisme/dinamis)
      const methodDead = names.get("method:unusedLegacyCheck");
      assert.ok(methodDead, "unusedLegacyCheck harus terdeteksi sebagai dead method");
      assert.equal(methodDead.confidence, "low");

      // --- B2: Pengecualian wajib (entrypoints, test files, framework routes, Protected paths, simbol yang dipakai) ---
      assert.ok(!names.has("function:formatCurrency"), "formatCurrency dipakai di index.ts — bukan dead code");
      assert.ok(!names.has("function:roundCents"), "roundCents dipanggil formatCurrency — bukan dead code");
      assert.ok(!names.has("class:UserValidator"), "UserValidator dipakai di index.ts — bukan dead code");
      assert.ok(!names.has("method:isValid"), "isValid dipanggil di index.ts — bukan dead code");

      for (const f of dead.findings) {
        assert.notEqual(f.path, "src/index.ts", "entrypoint main harus dikecualikan");
        assert.notEqual(f.path, "src/cli.ts", "entrypoint bin harus dikecualikan");
        assert.notEqual(f.path, "src/publicApi.ts", "entrypoint exports harus dikecualikan");
        assert.notEqual(f.path, "src/app/api/users/route.ts", "route framework harus dikecualikan");
        assert.notEqual(f.path, "migrations/001_init.ts", "path Protected harus dikecualikan");
        assert.notEqual(f.path, "tests/utils.test.ts", "file test harus dikecualikan");
      }
    } finally {
      db.close();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("dogfooding: scopecairn reuse dan dead bekerja bersih pada repo ScopeCairn sendiri", async () => {
  const repoRoot = path.resolve(import.meta.dirname, "..");
  await scanRepository(repoRoot);
  const db = openDb(repoRoot);
  try {
    // 1. Dogfood reuse pada repo sendiri
    const reuseRes = searchReuse(db, repoRoot, "tokenizeIdentifier camelCase", 5);
    assert.equal(reuseRes.empty, false);
    assert.ok(
      reuseRes.candidates.some((c) => c.name === "tokenizeIdentifier" && c.path === "src/retrieval/tokenize.ts"),
      "harus menemukan tokenizeIdentifier di repo ScopeCairn sendiri"
    );

    // 2. Dogfood dead pada repo sendiri: pastikan tidak ada dead code HIGH dan tidak ada dead code di modul baru
    const deadRes = findDeadCode(db, repoRoot);
    assert.equal(
      deadRes.byConfidence.high,
      0,
      `Repo ScopeCairn tidak boleh memiliki dead code berkeyakinan HIGH, ditemukan: ${deadRes.findings
        .filter((f) => f.confidence === "high")
        .map((f) => `${f.name} (${f.path})`)
        .join(", ")}`
    );
    const inNewFiles = deadRes.findings.filter(
      (f) => f.path === "src/commands/reuse.ts" || f.path === "src/commands/dead.ts"
    );
    assert.deepEqual(
      inNewFiles,
      [],
      "Perubahan baru (reuse.ts & dead.ts) tidak boleh meninggalkan dead code apa pun"
    );
  } finally {
    db.close();
  }
});

test("CLI output --json untuk cmdReuse dan cmdDead menghasilkan JSON terstruktur yang valid", async () => {
  const repoRoot = path.resolve(import.meta.dirname, "..");
  await scanRepository(repoRoot);
  const logs: string[] = [];
  const origLog = console.log;
  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  };
  try {
    await cmdReuse(repoRoot, "tokenizeIdentifier", { json: true, noRefresh: true, limit: 3 });
    assert.equal(logs.length, 1);
    const parsedReuse = JSON.parse(logs[0]) as { query: string; empty: boolean; candidates: Array<{ name: string; exported: boolean }> };
    assert.equal(parsedReuse.query, "tokenizeIdentifier");
    assert.equal(parsedReuse.empty, false);
    assert.equal(parsedReuse.candidates[0].name, "tokenizeIdentifier");
    assert.equal(parsedReuse.candidates[0].exported, true);

    logs.length = 0;
    await cmdReuse(repoRoot, "zzqxv_qqrmp_wklmn", { json: true, noRefresh: true });
    assert.equal(logs.length, 1);
    const parsedEmpty = JSON.parse(logs[0]) as { empty: boolean; candidates: unknown[] };
    assert.equal(parsedEmpty.empty, true);
    assert.deepEqual(parsedEmpty.candidates, []);

    logs.length = 0;
    await cmdDead(repoRoot, { json: true, noRefresh: true });
    assert.equal(logs.length, 1);
    const parsedDead = JSON.parse(logs[0]) as { total: number; byConfidence: { high: number; medium: number; low: number }; findings: unknown[] };
    assert.equal(typeof parsedDead.total, "number");
    assert.equal(parsedDead.byConfidence.high, 0);
    assert.ok(Array.isArray(parsedDead.findings));
  } finally {
    console.log = origLog;
  }
});
