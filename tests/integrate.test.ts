// Test integrasi agent: knowledge skill di matriks, siklus hidup install/
// uninstall (termasuk extra knowledge), allowlist, dan audit doctor.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AGENT_MATRIX, findTarget } from "../src/integrate/matrix.js";
import {
  installTarget,
  uninstallTarget,
  installAntigravity,
  uninstallAntigravity,
  antigravityRulePath,
  antigravityKnowledgeSkillPath,
  auditKnowledgeFiles,
} from "../src/integrate/install.js";
import {
  ALLOWLIST_COMMANDS,
  genericRuleMd,
  workflowMd,
  opencodeCommandMd,
  knowledgeSkillMd,
  allowlistGuide,
  opencodePermissionGuide,
} from "../src/integrate/templates.js";

function tmpRepo(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "integrate-"));
}

// Body tanpa frontmatter — dipakai untuk memastikan semua salinan identik.
function bodyOf(md: string): string {
  return md.split("---").slice(2).join("---");
}

test("setiap target matrix punya knowledge skill di mekanisme native-nya", () => {
  const expected: Record<string, string> = {
    claude: ".claude/skills/scopecairn-knowledge/SKILL.md",
    cursor: ".cursor/skills/scopecairn-knowledge/SKILL.md",
    windsurf: ".windsurf/skills/scopecairn-knowledge/SKILL.md",
    copilot: ".github/skills/scopecairn-knowledge/SKILL.md",
    kiro: ".kiro/skills/scopecairn-knowledge/SKILL.md",
    opencode: ".opencode/skills/scopecairn-knowledge/SKILL.md",
    qoder: ".qoder/skills/scopecairn-knowledge/SKILL.md",
  };
  for (const t of AGENT_MATRIX) {
    const files = t.extra ?? [];
    assert.equal(files.length, 1, `${t.id} harus punya satu knowledge file`);
    assert.equal(files[0].rel, expected[t.id]);
    assert.ok(files[0].render("scopecairn").includes("name: scopecairn-knowledge"));
  }
});

test("knowledge skill: frontmatter valid, body identik antar salinan, allowed-tools hanya claude", () => {
  const portable = knowledgeSkillMd("scopecairn");
  const claude = knowledgeSkillMd("scopecairn", "claude");
  assert.ok(portable.startsWith("---\n"));
  assert.ok(portable.includes("name: scopecairn-knowledge"));
  assert.ok(!portable.includes("allowed-tools"));
  assert.ok(claude.includes("allowed-tools: Bash"));
  assert.equal(bodyOf(portable), bodyOf(claude));
  for (const t of AGENT_MATRIX) {
    for (const e of t.extra ?? []) {
      assert.equal(bodyOf(e.render("scopecairn")), bodyOf(portable), `${e.rel} harus identik`);
    }
  }
  // Artefak cold start + kontrak baru dirujuk body.
  for (const needle of [
    ".scopecairn/GRAPH.md",
    "ARCHAEOLOGY.md",
    "decisions.md",
    "> Freshness:",
    "empty: true",
    "--knowledge",
  ]) {
    assert.ok(portable.includes(needle), `body harus menyebut ${needle}`);
  }
});

test("install menulis knowledge file untuk mode new dan merge, uninstall membersihkannya", () => {
  const dir = tmpRepo();
  try {
    // mode new: cursor
    const cursor = findTarget("cursor")!;
    const kRel = cursor.extra![0].rel;
    assert.equal(installTarget(dir, cursor, "scopecairn").how, "generated");
    assert.ok(fs.existsSync(path.join(dir, kRel)));
    // idempoten: render deterministik → byte identik.
    const before = fs.readFileSync(path.join(dir, kRel), "utf8");
    assert.equal(installTarget(dir, cursor, "scopecairn").how, "updated");
    assert.equal(fs.readFileSync(path.join(dir, kRel), "utf8"), before);

    // mode merge: copilot — konten user dipertahankan.
    const copilot = findTarget("copilot")!;
    fs.mkdirSync(path.dirname(path.join(dir, copilot.rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, copilot.rel), "# Instruksi user\n- tetap dipertahankan.\n");
    installTarget(dir, copilot, "scopecairn");
    const cpText = fs.readFileSync(path.join(dir, copilot.rel), "utf8");
    assert.ok(cpText.includes("Instruksi user"));
    assert.ok(cpText.includes("<!-- scopecairn:managed -->"));
    assert.ok(fs.existsSync(path.join(dir, copilot.extra![0].rel)));

    const out = uninstallTarget(dir, copilot);
    assert.equal(out.how, "removed");
    assert.ok(!fs.existsSync(path.join(dir, copilot.extra![0].rel)));
    const after = fs.readFileSync(path.join(dir, copilot.rel), "utf8");
    assert.ok(after.includes("Instruksi user"));
    assert.ok(!after.includes("scopecairn:managed"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("uninstall membersihkan knowledge file walau file utama sudah hilang", () => {
  const dir = tmpRepo();
  try {
    const cursor = findTarget("cursor")!;
    installTarget(dir, cursor, "scopecairn");
    fs.rmSync(path.join(dir, cursor.rel));
    const out = uninstallTarget(dir, cursor);
    // how melaporkan file UTAMA (sudah hilang) — extra tetap dibersihkan.
    assert.equal(out.how, "absent");
    assert.ok(!fs.existsSync(path.join(dir, cursor.extra![0].rel)));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("uninstall merge tanpa marker: how jujur 'skipped', extra tetap dibersihkan", () => {
  const dir = tmpRepo();
  try {
    const copilot = findTarget("copilot")!;
    fs.mkdirSync(path.dirname(path.join(dir, copilot.rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, copilot.rel), "# user\n- tanpa marker scopecairn\n");
    installTarget(dir, copilot, "scopecairn");
    assert.ok(fs.existsSync(path.join(dir, copilot.extra![0].rel)));
    // Simulasi blok merge hilang → uninstall tidak boleh mengklaim "removed".
    const text = fs.readFileSync(path.join(dir, copilot.rel), "utf8");
    fs.writeFileSync(
      path.join(dir, copilot.rel),
      text.replace("<!-- scopecairn:managed -->", "<!--bukan milik scopecairn-->")
    );
    const out = uninstallTarget(dir, copilot);
    assert.equal(out.how, "skipped");
    assert.ok(fs.readFileSync(path.join(dir, copilot.rel), "utf8").includes("# user"));
    assert.ok(!fs.existsSync(path.join(dir, copilot.extra![0].rel)));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("allowlist memuat history, reuse, dead, dan session — rule agen mewajibkan reuse, dead, dan session", () => {
  assert.ok((ALLOWLIST_COMMANDS as readonly string[]).includes("history"));
  assert.ok((ALLOWLIST_COMMANDS as readonly string[]).includes("reuse"));
  assert.ok((ALLOWLIST_COMMANDS as readonly string[]).includes("dead"));
  assert.ok((ALLOWLIST_COMMANDS as readonly string[]).includes("session"));
  assert.ok(allowlistGuide("scopecairn").includes("scopecairn history"));
  assert.ok(allowlistGuide("scopecairn").includes("scopecairn reuse"));
  assert.ok(allowlistGuide("scopecairn").includes("scopecairn dead"));
  assert.ok(allowlistGuide("scopecairn").includes("scopecairn session"));
  assert.ok(
    opencodePermissionGuide("scopecairn").includes(`"scopecairn history *": "allow"`)
  );
  assert.ok(
    opencodePermissionGuide("scopecairn").includes(`"scopecairn reuse *": "allow"`)
  );
  assert.ok(
    opencodePermissionGuide("scopecairn").includes(`"scopecairn dead *": "allow"`)
  );
  assert.ok(
    opencodePermissionGuide("scopecairn").includes(`"scopecairn session *": "allow"`)
  );
  for (const doc of [
    genericRuleMd("scopecairn"),
    workflowMd("scopecairn"),
    opencodeCommandMd("scopecairn"),
  ]) {
    assert.ok(doc.includes("scopecairn reuse"), "rule agen harus mewajibkan scopecairn reuse");
    assert.ok(doc.includes("scopecairn dead"), "rule agen harus mewajibkan scopecairn dead");
    assert.ok(doc.includes("scopecairn session load"), "rule agen harus mewajibkan scopecairn session load di awal sesi");
    assert.ok(doc.includes("scopecairn session save"), "rule agen harus mewajibkan scopecairn session save sebelum selesai");
  }
});

test("auditKnowledgeFiles mendeteksi file hilang dan prefix tak konsisten", () => {
  const dir = tmpRepo();
  try {
    const cursor = findTarget("cursor")!;
    const kRel = cursor.extra![0].rel;
    installTarget(dir, cursor, "scopecairn");
    const clean = auditKnowledgeFiles(dir, AGENT_MATRIX, "scopecairn");
    assert.equal(clean.total, 1);
    assert.equal(clean.ok, 1);
    assert.deepEqual(clean.missing, []);

    fs.rmSync(path.join(dir, kRel));
    const missing = auditKnowledgeFiles(dir, AGENT_MATRIX, "scopecairn");
    assert.deepEqual(missing.missing, [{ agent: "cursor", rel: kRel }]);
    assert.equal(missing.ok, 0);

    fs.writeFileSync(path.join(dir, kRel), knowledgeSkillMd("npx scopecairn"));
    const mismatch = auditKnowledgeFiles(dir, AGENT_MATRIX, "scopecairn");
    assert.equal(mismatch.prefixIssues.length, 1);
    assert.equal(mismatch.prefixIssues[0].used, "npx scopecairn");
    assert.equal(mismatch.ok, 0);

    // Target yang belum terpasang tidak dihitung (bukan masalah).
    const emptyDir = tmpRepo();
    try {
      const none = auditKnowledgeFiles(emptyDir, AGENT_MATRIX, "scopecairn");
      assert.equal(none.total, 0);
    } finally {
      fs.rmSync(emptyDir, { recursive: true, force: true });
    }

    // File milik user tanpa marker (copilot) → belum terpasang, bukan alarm.
    const userDir = tmpRepo();
    try {
      fs.mkdirSync(path.join(userDir, ".github"), { recursive: true });
      fs.writeFileSync(
        path.join(userDir, ".github", "copilot-instructions.md"),
        "# Instruksi user\n- bukan milik scopecairn\n"
      );
      const userOwned = auditKnowledgeFiles(userDir, AGENT_MATRIX, "scopecairn");
      assert.equal(userOwned.total, 0);
      assert.deepEqual(userOwned.missing, []);
    } finally {
      fs.rmSync(userDir, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("antigravity: rule, knowledge skill, dan AGENTS.md ditulis saat install dan dihapus saat uninstall", () => {
  const dir = tmpRepo();
  try {
    const lines = installAntigravity(dir, "scopecairn");
    assert.ok(lines.some((l) => l.includes("Rule installed")));
    assert.ok(lines.some((l) => l.includes("Knowledge skill installed")));
    assert.ok(lines.some((l) => l.includes("AGENTS.md created")));
    const rPath = antigravityRulePath(dir);
    const kPath = antigravityKnowledgeSkillPath(dir);
    const agentsPath = path.join(dir, "AGENTS.md");
    assert.ok(fs.existsSync(rPath));
    assert.ok(fs.readFileSync(rPath, "utf8").includes("ScopeCairn"));
    assert.ok(fs.existsSync(kPath));
    assert.ok(fs.readFileSync(kPath, "utf8").includes("name: scopecairn-knowledge"));
    assert.ok(fs.existsSync(agentsPath));
    assert.ok(fs.readFileSync(agentsPath, "utf8").includes("<!-- scopecairn:managed -->"));

    uninstallAntigravity(dir);
    assert.ok(!fs.existsSync(rPath));
    assert.ok(!fs.existsSync(kPath));
    assert.ok(!fs.existsSync(agentsPath));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("antigravity: install ke repo dengan AGENTS.md mempertahankan detail proyek user", () => {
  const dir = tmpRepo();
  try {
    const agentsPath = path.join(dir, "AGENTS.md");
    fs.writeFileSync(agentsPath, "# Detail Proyek User\n- ini tidak boleh hilang\n");
    const lines = installAntigravity(dir, "scopecairn");
    assert.ok(lines.some((l) => l.includes("AGENTS.md merged")));
    const content = fs.readFileSync(agentsPath, "utf8");
    assert.ok(content.includes("# Detail Proyek User"));
    assert.ok(content.includes("- ini tidak boleh hilang"));
    assert.ok(content.includes("<!-- scopecairn:managed -->"));

    // Uninstall hanya membersihkan blok managed, detail user tetap utuh
    const unLines = uninstallAntigravity(dir);
    assert.ok(unLines.some((l) => l.includes("AGENTS.md cleaned")));
    assert.ok(fs.existsSync(agentsPath));
    const after = fs.readFileSync(agentsPath, "utf8");
    assert.ok(after.includes("# Detail Proyek User"));
    assert.ok(after.includes("- ini tidak boleh hilang"));
    assert.ok(!after.includes("<!-- scopecairn:managed -->"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("claude: rule mirroring .claude/rules/scopecairn.md ditulis saat install dan dihapus saat uninstall", () => {
  const dir = tmpRepo();
  try {
    const claude = findTarget("claude")!;
    assert.ok(claude.companionRule);
    assert.equal(claude.companionRule.rel, ".claude/rules/scopecairn.md");
    installTarget(dir, claude, "scopecairn");
    const rulePath = path.join(dir, claude.companionRule.rel);
    assert.ok(fs.existsSync(rulePath));
    assert.ok(fs.readFileSync(rulePath, "utf8").includes("ScopeCairn"));
    uninstallTarget(dir, claude);
    assert.ok(!fs.existsSync(rulePath));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("qoder: rule selalu aktif di .qoder/rules dan knowledge skill di .qoder/skills", () => {
  const dir = tmpRepo();
  try {
    const qoder = findTarget("qoder")!;
    assert.equal(qoder.rel, ".qoder/rules/scopecairn.md");
    assert.equal(installTarget(dir, qoder, "scopecairn").how, "generated");

    const rulePath = path.join(dir, ".qoder", "rules", "scopecairn.md");
    assert.ok(fs.existsSync(rulePath));
    const rule = fs.readFileSync(rulePath, "utf8");
    assert.ok(rule.includes("ScopeCairn"));
    // Qoder menerapkan rule tanpa frontmatter loading ke SETIAP sesi.
    assert.ok(!rule.startsWith("---"));
    assert.ok(!rule.includes("trigger:"));
    const kPath = path.join(dir, ".qoder", "skills", "scopecairn-knowledge", "SKILL.md");
    assert.ok(fs.existsSync(kPath));
    assert.ok(fs.readFileSync(kPath, "utf8").includes("name: scopecairn-knowledge"));

    const out = uninstallTarget(dir, qoder);
    assert.equal(out.how, "removed");
    assert.ok(!fs.existsSync(rulePath));
    assert.ok(!fs.existsSync(kPath));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

