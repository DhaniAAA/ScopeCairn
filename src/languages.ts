export type SourceLanguage = "typescript" | "javascript" | "python" | "other";

const EXT_MAP: Record<string, SourceLanguage> = {
  ".ts": "typescript",
  ".tsx": "typescript",
  ".js": "javascript",
  ".jsx": "javascript",
  ".py": "python",
};

export function detectLanguage(filePath: string): SourceLanguage {
  const dot = filePath.lastIndexOf(".");
  if (dot === -1) return "other";
  const ext = filePath.slice(dot).toLowerCase();
  return EXT_MAP[ext] ?? "other";
}

export function isSourceFile(filePath: string): boolean {
  return detectLanguage(filePath) !== "other";
}
