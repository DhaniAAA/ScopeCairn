import {
  genericRuleMd,
  cursorRuleMdc,
  opencodeCommandMd,
  claudeSkillMd,
  knowledgeSkillMd,
} from "./templates.js";

// Matriks agent: tiap agent dilayani lewat mekanisme native-nya sendiri
// (skill, rules, command) — ScopeCairn TIDAK menulis AGENTS.md/CLAUDE.md,
// karena file itu milik detail repo user, bukan instruksi tool.
//
// Skill knowledge (read-only: explain/summarize/audit) dipasang sebagai
// `extra` di mekanisme "skill" native tiap agent: .claude/skills,
// .cursor/skills (Cursor >= 2.4), .windsurf/skills, .github/skills
// (Copilot/VS Code), .kiro/skills, .opencode/skills. Hanya salinan Claude
// yang memuat `allowed-tools`.

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
  /** Rule pendamping (mis. .claude/rules/scopecairn.md untuk Claude Code). */
  companionRule?: { rel: string; render: (prefix: string) => string };
  /** File tambahan yang ditulis sekaligus saat install (opsional). */
  extra?: Array<{ rel: string; render: (prefix: string) => string }>;
}

export const AGENT_MATRIX: AgentTarget[] = [
  {
    id: "claude",
    label: "Claude Code",
    rel: ".claude/skills/scopecairn/SKILL.md",
    mode: "new",
    render: claudeSkillMd,
    presentMarker: ".claude",
    companionRule: {
      rel: ".claude/rules/scopecairn.md",
      render: genericRuleMd,
    },
    extra: [
      {
        rel: ".claude/skills/scopecairn-knowledge/SKILL.md",
        render: (p) => knowledgeSkillMd(p, "claude"),
      },
    ],
  },
  {
    id: "cursor",
    label: "Cursor",
    rel: ".cursor/rules/scopecairn.mdc",
    mode: "new",
    render: cursorRuleMdc,
    presentMarker: ".cursor",
    extra: [
      {
        rel: ".cursor/skills/scopecairn-knowledge/SKILL.md",
        render: knowledgeSkillMd,
      },
    ],
  },
  {
    id: "windsurf",
    label: "Windsurf",
    rel: ".windsurf/rules/scopecairn.md",
    mode: "new",
    render: genericRuleMd,
    presentMarker: ".windsurf",
    extra: [
      {
        rel: ".windsurf/skills/scopecairn-knowledge/SKILL.md",
        render: knowledgeSkillMd,
      },
    ],
  },
  {
    id: "copilot",
    label: "GitHub Copilot",
    rel: ".github/copilot-instructions.md",
    mode: "merge",
    render: genericRuleMd,
    presentMarker: ".github",
    extra: [
      {
        rel: ".github/skills/scopecairn-knowledge/SKILL.md",
        render: knowledgeSkillMd,
      },
    ],
  },
  {
    id: "kiro",
    label: "Kiro",
    rel: ".kiro/steering/scopecairn.md",
    mode: "new",
    render: genericRuleMd,
    presentMarker: ".kiro",
    extra: [
      {
        rel: ".kiro/skills/scopecairn-knowledge/SKILL.md",
        render: knowledgeSkillMd,
      },
    ],
  },
  {
    id: "opencode",
    label: "OpenCode",
    rel: ".opencode/commands/scopecairn.md",
    mode: "new",
    render: opencodeCommandMd,
    presentMarker: ".opencode",
    extra: [
      {
        rel: ".opencode/skills/scopecairn-knowledge/SKILL.md",
        render: knowledgeSkillMd,
      },
    ],
  },
];

export function findTarget(id: string): AgentTarget | undefined {
  return AGENT_MATRIX.find((t) => t.id === id);
}

export function parseAgentsOption(
  raw: string | undefined,
): string[] | "all" | null {
  if (!raw) return null;
  if (raw.trim().toLowerCase() === "all") return "all";
  return raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}
