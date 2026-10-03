import {
  agentsMd,
  genericRuleMd,
  cursorRuleMdc,
} from "./templates.js";

// Matriks agent: satu isi aturan, banyak rumah. AGENTS.md dibaca hampir
// semua agent modern; file lain adalah shim tipis agar agent yang hanya
// membaca jalurnya sendiri tetap terpanggil.

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
    id: "agents",
    label: "AGENTS.md (universal: Codex, Aider, Opencode, Amp, Jules, ...)",
    rel: "AGENTS.md",
    mode: "merge",
    render: agentsMd,
    presentMarker: "AGENTS.md",
  },
  {
    id: "claude",
    label: "Claude Code",
    rel: "CLAUDE.md",
    mode: "merge",
    render: genericRuleMd,
    presentMarker: "CLAUDE.md",
  },
  {
    id: "gemini",
    label: "Gemini / Antigravity CLI",
    rel: "GEMINI.md",
    mode: "merge",
    render: genericRuleMd,
    presentMarker: "GEMINI.md",
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
