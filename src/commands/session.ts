import fs from "node:fs";
import path from "node:path";
import { dataDir } from "../db.js";
import { currentGitHead, gitDriftSince } from "../retrieval/gitChanged.js";

export const MAX_SESSION_CHARS = 4000;
export const SESSION_REL_PATH = ".scopecairn/session.md";

export interface SessionSections {
  working: string;
  decisions: string;
  nextSteps: string;
  blockers: string;
  keyFiles: string[];
}

export interface SessionSaveOptions {
  working?: string;
  decisions?: string;
  next?: string;
  blockers?: string;
  files?: string | string[];
  file?: string;
  content?: string;
  json?: boolean;
}

export interface SessionSaveResult {
  ok: boolean;
  path: string;
  charCount: number;
  maxChars: number;
  updatedAt?: string;
  gitHead?: string;
  error?: string;
  secretKinds?: string[];
}

export interface SessionLoadResult {
  exists: boolean;
  path: string;
  updatedAt: string | null;
  savedGitHead: string | null;
  currentGitHead: string | null;
  commitsSinceSave: number;
  changedFiles: string[];
  sections: SessionSections;
  raw: string | null;
}

interface SecretRule {
  label: string;
  pattern: RegExp;
}

const SECRET_RULES: SecretRule[] = [
  {
    label: "OpenAI / Anthropic API Key",
    pattern: /\bsk-(?:proj-|ant-|live-|test-)?[A-Za-z0-9_-]{16,}\b/,
  },
  {
    label: "GitHub Token",
    pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b|\bgithub_pat_[A-Za-z0-9_]{20,}\b/,
  },
  {
    label: "AWS Access Key",
    pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/,
  },
  {
    label: "Google API Key",
    pattern: /\bAIza[0-9A-Za-z_-]{35}\b/,
  },
  {
    label: "Slack Token",
    pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/,
  },
  {
    label: "Stripe API Key",
    pattern: /\b(?:sk|rk)_(?:live|test)_[0-9a-zA-Z]{16,}\b/,
  },
  {
    label: "Private Key",
    pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/,
  },
  {
    label: "JWT Token",
    pattern: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/,
  },
  {
    label: "Bearer Token",
    pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}\b/,
  },
  {
    label: "Generic Secret / Token Assignment",
    pattern:
      /(?:api[_-]?key|secret[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|private[_-]?key|password|passwd)\s*[:=]\s*["']?[A-Za-z0-9._~+/=-]{8,}["']?/i,
  },
];

/** Deteksi pola rahasia (API key, token, private key) pada teks sesi. */
export function detectSecrets(text: string): string[] {
  const found: string[] = [];
  for (const rule of SECRET_RULES) {
    if (rule.pattern.test(text)) {
      found.push(rule.label);
    }
  }
  return found;
}

function sessionAbsPath(repoRoot: string): string {
  return path.join(dataDir(repoRoot), "session.md");
}

/**
 * Pastikan `.scopecairn/session.md` masuk `.gitignore` secara default
 * (baik di `.gitignore` root proyek maupun `.scopecairn/.gitignore`).
 */
export function ensureSessionGitignored(repoRoot: string): void {
  const scDir = dataDir(repoRoot);
  fs.mkdirSync(scDir, { recursive: true });
  const scIgnore = path.join(scDir, ".gitignore");
  if (!fs.existsSync(scIgnore)) {
    fs.writeFileSync(scIgnore, "session.md\nscopecairn.db*\n", "utf8");
  } else {
    const cur = fs.readFileSync(scIgnore, "utf8");
    const lines = cur.split(/\r?\n/).map((l) => l.trim());
    if (!lines.includes("session.md") && !lines.includes("/session.md")) {
      const prefix = cur.endsWith("\n") || cur.length === 0 ? cur : `${cur}\n`;
      fs.writeFileSync(scIgnore, `${prefix}session.md\n`, "utf8");
    }
  }

  const rootIgnore = path.join(repoRoot, ".gitignore");
  if (!fs.existsSync(rootIgnore)) {
    fs.writeFileSync(rootIgnore, `.scopecairn/\n${SESSION_REL_PATH}\n`, "utf8");
    return;
  }
  const raw = fs.readFileSync(rootIgnore, "utf8");
  const existingLines = raw.split(/\r?\n/).map((l) => l.trim());
  if (!existingLines.includes(SESSION_REL_PATH)) {
    const prefix = raw.endsWith("\n") || raw.length === 0 ? raw : `${raw}\n`;
    fs.writeFileSync(rootIgnore, `${prefix}${SESSION_REL_PATH}\n`, "utf8");
  }
}

function parseFilesInput(files?: string | string[]): string[] | undefined {
  if (files === undefined) return undefined;
  const list = Array.isArray(files) ? files : [files];
  const out: string[] = [];
  for (const item of list) {
    for (const part of item.split(/[\n,]+/)) {
      const cleaned = part.replace(/^[-*]\s+/, "").trim();
      if (cleaned && !out.includes(cleaned)) out.push(cleaned);
    }
  }
  return out;
}

function parseSessionMarkdown(raw: string): {
  updatedAt: string | null;
  savedGitHead: string | null;
  sections: SessionSections;
} {
  let updatedAt: string | null = null;
  let savedGitHead: string | null = null;

  const lines = raw.replace(/\r\n/g, "\n").split("\n");
  const sectionMap = new Map<string, string[]>();
  let currentHeader: string | null = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!currentHeader) {
      const mUpdated = /^-\s*updated_at:\s*(.+)$/i.exec(trimmed);
      if (mUpdated) {
        updatedAt = mUpdated[1].trim();
        continue;
      }
      const mHead = /^-\s*git_head:\s*(.+)$/i.exec(trimmed);
      if (mHead) {
        savedGitHead = mHead[1].trim();
        continue;
      }
    }

    const mHeading = /^##\s+(.+)$/.exec(trimmed);
    if (mHeading) {
      currentHeader = mHeading[1].trim().toLowerCase();
      if (!sectionMap.has(currentHeader)) {
        sectionMap.set(currentHeader, []);
      }
      continue;
    }

    if (currentHeader) {
      sectionMap.get(currentHeader)!.push(line);
    }
  }

  const pickSection = (keys: string[]): string => {
    for (const k of keys) {
      const buf = sectionMap.get(k);
      if (buf) {
        const joined = buf.join("\n").trim();
        if (joined) return joined;
      }
    }
    return "-";
  };

  const working = pickSection(["sedang dikerjakan", "working on", "working"]);
  const decisions = pickSection(["keputusan", "decisions"]);
  const nextSteps = pickSection(["langkah berikutnya", "next steps", "next"]);
  const blockers = pickSection(["blocker", "blockers"]);
  const filesRaw = pickSection(["file penting", "key files", "files"]);

  const keyFiles: string[] = [];
  if (filesRaw !== "-") {
    for (const line of filesRaw.split("\n")) {
      const cleaned = line.replace(/^[-*]\s+/, "").trim();
      if (cleaned && cleaned !== "-") keyFiles.push(cleaned);
    }
  }

  return {
    updatedAt,
    savedGitHead,
    sections: {
      working,
      decisions,
      nextSteps,
      blockers,
      keyFiles,
    },
  };
}

function formatSessionMarkdown(
  updatedAt: string,
  gitHead: string,
  sections: SessionSections
): string {
  const filesBlock =
    sections.keyFiles.length > 0
      ? sections.keyFiles.map((f) => `- ${f}`).join("\n")
      : "-";

  return (
    `# ScopeCairn Session\n` +
    `- updated_at: ${updatedAt}\n` +
    `- git_head: ${gitHead}\n\n` +
    `## Sedang Dikerjakan\n` +
    `${sections.working.trim() || "-"}\n\n` +
    `## Keputusan\n` +
    `${sections.decisions.trim() || "-"}\n\n` +
    `## Langkah Berikutnya\n` +
    `${sections.nextSteps.trim() || "-"}\n\n` +
    `## Blocker\n` +
    `${sections.blockers.trim() || "-"}\n\n` +
    `## File Penting\n` +
    `${filesBlock}\n`
  );
}

/** Tulis file secara atomik melalui file sementara lalu rename. */
function atomicWriteFile(targetPath: string, content: string): void {
  const dir = path.dirname(targetPath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = path.join(
    dir,
    `${path.basename(targetPath)}.tmp.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`
  );
  try {
    fs.writeFileSync(tmpPath, content, "utf8");
    fs.renameSync(tmpPath, targetPath);
  } catch (err) {
    try {
      if (fs.existsSync(tmpPath)) fs.rmSync(tmpPath, { force: true });
    } catch {
      // ignore cleanup error
    }
    throw err;
  }
}

export function saveSession(repoRoot: string, opts: SessionSaveOptions): SessionSaveResult {
  let rawFromFileOrContent: string | undefined = opts.content;
  if (opts.file) {
    const absInput = path.resolve(repoRoot, opts.file);
    if (!fs.existsSync(absInput)) {
      return {
        ok: false,
        path: SESSION_REL_PATH,
        charCount: 0,
        maxChars: MAX_SESSION_CHARS,
        error: `Simpan sesi ditolak: file input tidak ditemukan (${opts.file})`,
      };
    }
    rawFromFileOrContent = fs.readFileSync(absInput, "utf8");
  }

  const hasSectionFlags =
    opts.working !== undefined ||
    opts.decisions !== undefined ||
    opts.next !== undefined ||
    opts.blockers !== undefined ||
    opts.files !== undefined;

  if (!hasSectionFlags && (!rawFromFileOrContent || rawFromFileOrContent.trim().length === 0)) {
    return {
      ok: false,
      path: SESSION_REL_PATH,
      charCount: 0,
      maxChars: MAX_SESSION_CHARS,
      error:
        "Simpan sesi ditolak: isi sesi kosong (gunakan --working, --decisions, --next, --blockers, --files, atau --file)",
    };
  }

  // Ambil nilai sesi sebelumnya bila ada untuk melengkapi field yang tidak diubah
  let baseSections: SessionSections = {
    working: "-",
    decisions: "-",
    nextSteps: "-",
    blockers: "-",
    keyFiles: [],
  };

  const targetPath = sessionAbsPath(repoRoot);
  if (fs.existsSync(targetPath)) {
    try {
      const existingRaw = fs.readFileSync(targetPath, "utf8");
      baseSections = parseSessionMarkdown(existingRaw).sections;
    } catch {
      // ignore corrupt previous session
    }
  }

  if (rawFromFileOrContent !== undefined) {
    // Cek terlebih dahulu batas dan rahasia pada input mentah
    const rawSecrets = detectSecrets(rawFromFileOrContent);
    if (rawSecrets.length > 0) {
      return {
        ok: false,
        path: SESSION_REL_PATH,
        charCount: rawFromFileOrContent.length,
        maxChars: MAX_SESSION_CHARS,
        error: `Simpan sesi ditolak: terdeteksi pola rahasia (${rawSecrets.join(", ")})`,
        secretKinds: rawSecrets,
      };
    }
    if (rawFromFileOrContent.length > MAX_SESSION_CHARS) {
      return {
        ok: false,
        path: SESSION_REL_PATH,
        charCount: rawFromFileOrContent.length,
        maxChars: MAX_SESSION_CHARS,
        error: `Simpan sesi ditolak: panjang ${rawFromFileOrContent.length} karakter melebihi batas maksimal ${MAX_SESSION_CHARS} karakter`,
      };
    }

    const parsedInput = parseSessionMarkdown(rawFromFileOrContent);
    const hasRecognizedSections =
      parsedInput.sections.working !== "-" ||
      parsedInput.sections.decisions !== "-" ||
      parsedInput.sections.nextSteps !== "-" ||
      parsedInput.sections.blockers !== "-" ||
      parsedInput.sections.keyFiles.length > 0;

    if (hasRecognizedSections) {
      baseSections = parsedInput.sections;
    } else {
      baseSections.working = rawFromFileOrContent.trim();
    }
  }

  const parsedFiles = parseFilesInput(opts.files);
  const finalSections: SessionSections = {
    working: opts.working !== undefined ? opts.working.trim() || "-" : baseSections.working,
    decisions: opts.decisions !== undefined ? opts.decisions.trim() || "-" : baseSections.decisions,
    nextSteps: opts.next !== undefined ? opts.next.trim() || "-" : baseSections.nextSteps,
    blockers: opts.blockers !== undefined ? opts.blockers.trim() || "-" : baseSections.blockers,
    keyFiles: parsedFiles !== undefined ? parsedFiles : baseSections.keyFiles,
  };

  const updatedAt = new Date().toISOString();
  const gitHead = currentGitHead(repoRoot) ?? "none";
  const markdown = formatSessionMarkdown(updatedAt, gitHead, finalSections);

  const secretKinds = detectSecrets(markdown);
  if (secretKinds.length > 0) {
    return {
      ok: false,
      path: SESSION_REL_PATH,
      charCount: markdown.length,
      maxChars: MAX_SESSION_CHARS,
      error: `Simpan sesi ditolak: terdeteksi pola rahasia (${secretKinds.join(", ")})`,
      secretKinds,
    };
  }

  if (markdown.length > MAX_SESSION_CHARS) {
    return {
      ok: false,
      path: SESSION_REL_PATH,
      charCount: markdown.length,
      maxChars: MAX_SESSION_CHARS,
      error: `Simpan sesi ditolak: panjang ${markdown.length} karakter melebihi batas maksimal ${MAX_SESSION_CHARS} karakter`,
    };
  }

  ensureSessionGitignored(repoRoot);
  atomicWriteFile(targetPath, markdown);

  return {
    ok: true,
    path: SESSION_REL_PATH,
    charCount: markdown.length,
    maxChars: MAX_SESSION_CHARS,
    updatedAt,
    gitHead,
  };
}

export function loadSession(repoRoot: string): SessionLoadResult {
  const targetPath = sessionAbsPath(repoRoot);
  if (!fs.existsSync(targetPath)) {
    const drift = gitDriftSince(repoRoot, null);
    return {
      exists: false,
      path: SESSION_REL_PATH,
      updatedAt: null,
      savedGitHead: null,
      currentGitHead: drift.currentHead,
      commitsSinceSave: 0,
      changedFiles: [],
      sections: {
        working: "-",
        decisions: "-",
        nextSteps: "-",
        blockers: "-",
        keyFiles: [],
      },
      raw: null,
    };
  }

  const raw = fs.readFileSync(targetPath, "utf8");
  const parsed = parseSessionMarkdown(raw);
  const drift = gitDriftSince(repoRoot, parsed.savedGitHead);

  return {
    exists: true,
    path: SESSION_REL_PATH,
    updatedAt: parsed.updatedAt,
    savedGitHead: parsed.savedGitHead,
    currentGitHead: drift.currentHead,
    commitsSinceSave: drift.commitsSinceSave,
    changedFiles: drift.changedFiles,
    sections: parsed.sections,
    raw,
  };
}

export function cmdSessionSave(repoRoot: string, opts: SessionSaveOptions): void {
  const res = saveSession(repoRoot, opts);
  if (opts.json) {
    console.log(JSON.stringify(res, null, 2));
    if (!res.ok) process.exitCode = 1;
    return;
  }

  if (!res.ok) {
    console.error(`✗ ${res.error}`);
    process.exitCode = 1;
    return;
  }

  console.log(
    `✓ Sesi disimpan ke ${res.path} (${res.charCount}/${res.maxChars} karakter · HEAD ${res.gitHead} · ${res.updatedAt})`
  );
}

export function cmdSessionLoad(repoRoot: string, opts: { json?: boolean } = {}): void {
  const res = loadSession(repoRoot);
  if (opts.json) {
    console.log(JSON.stringify(res, null, 2));
    return;
  }

  if (!res.exists || !res.raw) {
    console.log(`# ScopeCairn Session\n`);
    console.log(`Belum ada sesi tersimpan (${res.path} tidak ditemukan).`);
    console.log(
      `Simpan dengan: scopecairn session save --working "..." --decisions "..." --next "..." --blockers "..." --files "a.ts,b.ts"`
    );
    return;
  }

  console.log(res.raw.trimEnd());
  console.log(`\n## Perubahan Sejak Save Terakhir`);
  console.log(
    `- Saved HEAD: ${res.savedGitHead ?? "none"} → Current HEAD: ${res.currentGitHead ?? "none"}`
  );
  console.log(`- Jumlah commit baru: ${res.commitsSinceSave}`);
  console.log(`- File berubah (${res.changedFiles.length}):`);
  if (res.changedFiles.length === 0) {
    console.log(`  - (tidak ada perubahan file sejak save terakhir)`);
  } else {
    for (const f of res.changedFiles) {
      console.log(`  - ${f}`);
    }
  }
}
