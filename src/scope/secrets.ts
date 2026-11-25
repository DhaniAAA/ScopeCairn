import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { isTestPath } from "../retrieval/retrieve.js";
import { loadConfig } from "../retrieval/config.js";

export interface SecretRule {
  label: string;
  pattern: RegExp;
}

export interface SecretsScanConfig {
  allowlist?: RegExp[];
  customRules?: SecretRule[];
}

export interface SecretFinding {
  file: string;
  line: number;
  kind: string;
  preview: string;
}

export const SECRET_RULES: SecretRule[] = [
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

const PLACEHOLDER_RE = /(?:your[_-]|example|placeholder|changeme|dummy|sample|test[_-]?key|<[^>]+>|x{5,}|\*{4,})/i;
export const INLINE_SECRET_SUPPRESS_RE = /scopecairn:ignore-secret/i;

/** Muat `secrets_allowlist` & `secrets_rules` dari `.scopecairn/config.yml` (aman jika regex invalid). */
export function loadSecretsScanConfig(repoRoot: string): SecretsScanConfig {
  const cfg = loadConfig(repoRoot);
  const allowlist: RegExp[] = [];
  for (const raw of cfg.secretsAllowlist) {
    try {
      allowlist.push(new RegExp(raw));
    } catch {
      // abaikan regex invalid di config.yml
    }
  }
  const customRules: SecretRule[] = [];
  for (const r of cfg.secretsRules) {
    try {
      customRules.push({ label: r.label, pattern: new RegExp(r.pattern) });
    } catch {
      // abaikan regex invalid di config.yml
    }
  }
  return { allowlist, customRules };
}

function isSuppressedLine(content: string, secretsCfg?: SecretsScanConfig): boolean {
  if (PLACEHOLDER_RE.test(content) || INLINE_SECRET_SUPPRESS_RE.test(content)) return true;
  if (secretsCfg?.allowlist?.some((re) => re.test(content))) return true;
  return false;
}

/** Deteksi pola rahasia (API key, token, private key) pada teks. */
export function detectSecrets(text: string, secretsCfg?: SecretsScanConfig): string[] {
  const found: string[] = [];
  const rules = [...SECRET_RULES, ...(secretsCfg?.customRules ?? [])];
  for (const rule of rules) {
    if (rule.pattern.test(text)) {
      found.push(rule.label);
    }
  }
  return found;
}

function maskSecretMatch(match: string): string {
  const trimmed = match.trim();
  if (trimmed.length <= 8) return "***";
  return `${trimmed.slice(0, 4)}***${trimmed.slice(-2)}`;
}

function maskLinePreview(line: string, pattern: RegExp): string {
  const m = pattern.exec(line);
  if (!m) return line.trim().slice(0, 80);
  const masked = line.replace(m[0], maskSecretMatch(m[0])).trim();
  return masked.length > 100 ? masked.slice(0, 100) + "..." : masked;
}

/**
 * Ekstrak baris yang ditambahkan dari unified diff beserta nomor baris target.
 */
export function scanUnifiedDiffForSecrets(
  diffText: string,
  filePath: string,
  secretsCfg?: SecretsScanConfig
): SecretFinding[] {
  const findings: SecretFinding[] = [];
  const seen = new Set<string>();
  const rules = [...SECRET_RULES, ...(secretsCfg?.customRules ?? [])];
  const hunkRe = /^@@\s+-\d+(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/;
  let currentLine = 0;
  let inHunk = false;

  for (const rawLine of diffText.split(/\r?\n/)) {
    if (rawLine.startsWith("+++") || rawLine.startsWith("---")) {
      continue;
    }
    const hm = hunkRe.exec(rawLine.trim());
    if (hm) {
      currentLine = Number.parseInt(hm[1], 10);
      inHunk = Number.isFinite(currentLine);
      continue;
    }
    if (!inHunk) continue;

    if (rawLine.startsWith("+")) {
      const content = rawLine.slice(1);
      if (!isSuppressedLine(content, secretsCfg)) {
        for (const rule of rules) {
          if (rule.pattern.test(content)) {
            const key = `${filePath}:${currentLine}:${rule.label}`;
            if (!seen.has(key)) {
              seen.add(key);
              findings.push({
                file: filePath,
                line: currentLine,
                kind: rule.label,
                preview: maskLinePreview(content, rule.pattern),
              });
            }
          }
        }
      }
      currentLine++;
    } else if (!rawLine.startsWith("-") && !rawLine.startsWith("\\")) {
      currentLine++;
    }
  }

  return findings;
}

function scanPlainFileForSecrets(
  absPath: string,
  relPath: string,
  secretsCfg?: SecretsScanConfig
): SecretFinding[] {
  const findings: SecretFinding[] = [];
  let raw: string;
  try {
    const st = fs.statSync(absPath);
    if (!st.isFile() || st.size > 512_000) return findings;
    raw = fs.readFileSync(absPath, "utf8");
  } catch {
    return findings;
  }
  const rules = [...SECRET_RULES, ...(secretsCfg?.customRules ?? [])];
  const lines = raw.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const content = lines[i];
    if (isSuppressedLine(content, secretsCfg)) continue;
    for (const rule of rules) {
      if (rule.pattern.test(content)) {
        findings.push({
          file: relPath,
          line: i + 1,
          kind: rule.label,
          preview: maskLinePreview(content, rule.pattern),
        });
      }
    }
  }
  return findings;
}

/**
 * Pindai perubahan git (diff ter-stage/working-tree, baseRef...HEAD, serta file baru untracked)
 * untuk kebocoran API key, token, atau private key. Melewati test files dan `.scopecairn/`.
 */
export function scanSecretsInDiff(
  repoRoot: string,
  changedFiles: string[],
  baseRef?: string,
  secretsCfg?: SecretsScanConfig
): SecretFinding[] {
  const effectiveCfg = secretsCfg ?? loadSecretsScanConfig(repoRoot);
  const findings: SecretFinding[] = [];
  const seen = new Set<string>();
  const addFindings = (list: SecretFinding[]) => {
    for (const f of list) {
      const k = `${f.file}:${f.line}:${f.kind}`;
      if (!seen.has(k)) {
        seen.add(k);
        findings.push(f);
      }
    }
  };

  const candidates = changedFiles.filter(
    (f) => !f.startsWith(".scopecairn/") && !isTestPath(f)
  );

  for (const rel of candidates) {
    let gotDiff = false;
    if (baseRef) {
      try {
        const dBase = execFileSync("git", ["diff", "-U0", `${baseRef}...HEAD`, "--", rel], {
          cwd: repoRoot,
          encoding: "utf8",
          timeout: 8000,
          stdio: ["ignore", "pipe", "ignore"],
        });
        if (dBase.trim().length > 0) {
          gotDiff = true;
          addFindings(scanUnifiedDiffForSecrets(dBase, rel, effectiveCfg));
        }
      } catch {
        // ignore
      }
    }

    try {
      const dHead = execFileSync("git", ["diff", "-U0", "HEAD", "--", rel], {
        cwd: repoRoot,
        encoding: "utf8",
        timeout: 8000,
        stdio: ["ignore", "pipe", "ignore"],
      });
      if (dHead.trim().length > 0) {
        gotDiff = true;
        addFindings(scanUnifiedDiffForSecrets(dHead, rel, effectiveCfg));
      }
    } catch {
      // ignore
    }

    if (!gotDiff) {
      // Untracked atau baru ditambahkan di index tanpa HEAD (mis. initial commit)
      const abs = path.join(repoRoot, ...rel.split("/"));
      if (fs.existsSync(abs)) {
        addFindings(scanPlainFileForSecrets(abs, rel, effectiveCfg));
      }
    }
  }

  return findings;
}
