import { isProtected } from "./protected.js";

// Task Scope (PRD FR-07): bagi file kandidat ke Required / Optional / Protected.
export interface TaskScope {
  required: string[];
  optional: string[];
  protected: string[];
}

export function computeScope(
  highFiles: string[],
  mediumFiles: string[],
  testFiles: string[],
  patterns: string[]
): TaskScope {
  const required: string[] = [];
  const optional: string[] = [];
  const protectedFiles: string[] = [];
  const seen = new Set<string>();

  const place = (f: string): void => {
    if (seen.has(f)) return;
    seen.add(f);
    if (isProtected(f, patterns)) protectedFiles.push(f);
    else if (highFiles.includes(f)) required.push(f);
    else optional.push(f);
  };

  for (const f of highFiles) place(f);
  for (const f of mediumFiles) place(f);
  // Test selalu Optional (boleh disentuh untuk verifikasi), kecuali Protected.
  for (const t of testFiles) {
    if (seen.has(t)) continue;
    seen.add(t);
    if (isProtected(t, patterns)) protectedFiles.push(t);
    else optional.push(t);
  }

  return { required, optional, protected: protectedFiles };
}

export function scopeBlock(scope: TaskScope): string {
  const fmt = (xs: string[]): string => (xs.length > 0 ? xs.join(", ") : "-");
  return (
    `## Scope\nRequired: ${fmt(scope.required)}\n` +
    `Optional: ${fmt(scope.optional)}\n` +
    `Protected: ${fmt(scope.protected)}\n`
  );
}
