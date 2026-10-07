// Tokenizer identifier (PRD FR-04): pecah camelCase, PascalCase,
// snake_case, kebab-case, dan path — untuk SEED matching di FTS5.
// Ini pencocokan token, bukan embedding.

const STOP = new Set([
  "the", "a", "an", "of", "to", "in", "for", "on", "with", "and", "or",
  "src", "lib", "app", "test", "tests", "spec",
]);

export function tokenizeIdentifier(raw: string): string[] {
  const parts = raw
    .replace(/[\\/]/g, " ")
    .replace(/[.:\-_"']/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .filter((t) => t.length >= 2 && !STOP.has(t));
  return [...new Set(parts)];
}

export function tokenizeTask(text: string): string[] {
  return tokenizeIdentifier(text);
}
