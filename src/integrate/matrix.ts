import {
  genericRuleMd,
  cursorRuleMdc,
  opencodeCommandMd,
  claudeSkillMd,
} from "./templates.js";

// Matriks agent: tiap agent dilayani lewat mekanisme native-nya sendiri
// (skill, rules, command) — ScopeCairn TIDAK menulis AGENTS.md/CLAUDE.md,
// karena file itu milik detail repo user, bukan instruksi tool.

export interface AgentTarget {
  id: string;
  label: string;
  /** Path relatif dari repo root (untuk display). */
  rel: string;
  /** 'merge' = gabung ke file milik user via marker; 'new' = tulis file sendiri. */
  mode: "merge" | "new";
  render: (prefix: string) => string;
  /** Petanda setup agent sudah ada (direktori/file) untuk deteksi otomatis. */
  presentMarker: string;
}

export const AGENT_MATRIX: AgentTarget[] = [
  {
    id: "claude",
    label: "Claude Code",
    rel: ".claude/skills/scopecairn/SKILL.md",
    mode: "new",
    render: claudeSkillMd,
    presentMarker: ".claude",
  },
  {
    id: "cursor",
    label: "Cursor",
    rel: ".cursor/rules/scopecairn.mdc",
    mode: "new",
    render: cursorRuleMdc,
    presentMarker: ".cursor",
  },
  {
    id: "windsurf",
    label: "Windsurf",
    rel: ".windsurf/rules/scopecairn.md",
    mode: "new",
    render: genericRuleMd,
    presentMarker: ".windsurf",
  },
  {
    id: "copilot",
    label: "GitHub Copilot",
    rel: ".github/copilot-instructions.md",
    mode: "merge",
    render: genericRuleMd,
    presentMarker: ".github",
  },
  {
    id: "kiro",
    label: "Kiro",
    rel: ".kiro/steering/scopecairn.md",
    mode: "new",
    render: genericRuleMd,
    presentMarker: ".kiro",
  },
  {
    id: "opencode",
    label: "OpenCode",
    rel: ".opencode/commands/scopecairn.md",
    mode: "new",
    render: opencodeCommandMd,
    presentMarker: ".opencode",
  },
];

export function findTarget(id: string): AgentTarget | undefined {
  return AGENT_MATRIX.find((t) => t.id === id);
}

export function parseAgentsOption(raw: string | undefined): string[] | "all" | null {
  if (!raw) return null;
  if (raw.trim().toLowerCase() === "all") return "all";
  return raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}
