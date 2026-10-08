export type SourceLanguage =
  | "typescript"
  | "javascript"
  | "python"
  | "java"
  | "go"
  | "rust"
  | "php"
  | "csharp"
  | "cpp"
  | "c"
  | "ruby"
  | "html"
  | "vue"
  | "other";

const EXT_MAP: Record<string, SourceLanguage> = {
  ".ts": "typescript",
  ".tsx": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".js": "javascript",
  ".jsx": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".py": "python",
  ".pyw": "python",
  ".java": "java",
  ".go": "go",
  ".rs": "rust",
  ".php": "php",
  ".cs": "csharp",
  ".cpp": "cpp",
  ".cc": "cpp",
  ".cxx": "cpp",
  ".hpp": "cpp",
  ".h": "c",
  ".c": "c",
  ".rb": "ruby",
  ".html": "html",
  ".htm": "html",
  ".vue": "vue",
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
