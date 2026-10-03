import { WEIGHT, type FileExtraction, type RelationType } from "./types.js";

function lineOf(text: string, index: number): number {
  return text.slice(0, index).split("\n").length;
}

// Blank out string literals + comments (keep newlines) so CALLS detection
// doesn't fire on text like "source files (ts/tsx...)".
function stripStringsAndComments(src: string): string {
  let out = "";
  let i = 0;
  let quote: string | null = null;
  while (i < src.length) {
    const c = src[i];
    const nxt = src[i + 1] ?? "";
    if (quote) {
      if (c === "\\") {
        out += "  ";
        i += 2;
        continue;
      }
      if (c === "\n") {
        out += "\n";
        if (quote !== "`") quote = null;
        i++;
        continue;
      }
      if (c === quote) quote = null;
      out += " ";
      i++;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      quote = c;
      out += " ";
      i++;
      continue;
    }
    if (c === "/" && nxt === "/") {
      while (i < src.length && src[i] !== "\n") {
        out += " ";
        i++;
      }
      continue;
    }
    if (c === "/" && nxt === "*") {
      out += "  ";
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) {
        out += src[i] === "\n" ? "\n" : " ";
        i++;
      }
      out += "  ";
      i += 2;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

// Shared TS/JS extractor (.ts/.tsx/.js/.jsx). Deterministic, zero-dep.
// Captures: import, export, function, class (+extends/implements),
// interface, type, variable, method (class members), component (PascalCase
// function returning JSX heuristic), calls (identifier + "(").
export function extractTypeScript(source: string, isTsx: boolean): FileExtraction {
  const symbols: FileExtraction["symbols"] = [];
  const relations: FileExtraction["relations"] = [];
  const pushRel = (
    from: string,
    to: string,
    rel: RelationType,
    confidence = 1.0
  ) => relations.push({ from, to, rel, weight: WEIGHT[rel], confidence });
  // --- imports: import x from "mod" / import {a,b} from "mod" / import "mod" / require("mod")
  const importRe =
    /import\s+(?:(?:[\w*{}\s,]+?)\s+from\s+)?["']([^"']+)["']|require\(\s*["']([^"']+)["']\s*\)/g;
  let m: RegExpExecArray | null;
  while ((m = importRe.exec(source)) !== null) {
    const mod = m[1] ?? m[2];
    if (!mod) continue;
    const ln = lineOf(source, m.index);
    symbols.push({
      name: `import:${mod}`,
      type: "import",
      signature: m[0].slice(0, 120),
      startLine: ln,
      endLine: ln,
    });
    // Dynamic import() gets lower confidence.
    const dynamic = m[0].trimStart().startsWith("import(");
    pushRel("__file__", mod, "IMPORTS", dynamic ? 0.6 : 1.0);
  }

  // --- exports: export { a } / export * from "mod" / export const/function/class
  const exportStarRe = /export\s+\*\s+from\s+["']([^"']+)["']/g;
  while ((m = exportStarRe.exec(source)) !== null) {
    const mod = m[1];
    const ln = lineOf(source, m.index);
    symbols.push({
      name: `export*:${mod}`,
      type: "export",
      signature: m[0].slice(0, 120),
      startLine: ln,
      endLine: ln,
    });
    pushRel("__file__", mod, "EXPORTS", 0.7);
  }

  // --- function: function name( / export [async] function name(
  // (Arrow `const f = (...) =>` ditangani pola arrow di bawah; pola
  // `const x = (` sengaja TIDAK dipakai — ia menjaring ekspresi
  // parenthesized biasa seperti `const mod = (a ?? b).trim()`.)
  const funcRe =
    /(?:export\s+(?:default\s+)?)?(?:async\s+)?function\s+(\w+)\s*\(|(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*async\s*\(/g;
  const funcNames = new Set<string>();
  while ((m = funcRe.exec(source)) !== null) {
    const name = m[1] ?? m[2];
    if (!name) continue;
    funcNames.add(name);
    const ln = lineOf(source, m.index);
    // Component heuristic: PascalCase + file is tsx/jsx + JSX-looking body nearby.
    const looksJsx =
      isTsx &&
      /^[A-Z]/.test(name) &&
      /<[A-Z][\w]*|<>|return\s*\(/.test(source.slice(m.index, m.index + 2000));
    symbols.push({
      name,
      type: looksJsx ? "component" : "function",
      signature: m[0].slice(0, 120),
      startLine: ln,
      endLine: ln,
    });
    if (/^export\s/.test(m[0])) pushRel("__file__", name, "EXPORTS", 1.0);
  }

  // --- arrow const: const name = async (...) => / const name = <T>(...) =>
  const arrowRe = /(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s*)?(?:<[^=]*>)?\([^)]*\)\s*=>/g;
  while ((m = arrowRe.exec(source)) !== null) {
    const name = m[1];
    if (funcNames.has(name)) continue;
    funcNames.add(name);
    const ln = lineOf(source, m.index);
    symbols.push({
      name,
      type: /^[A-Z]/.test(name) && isTsx ? "component" : "function",
      signature: m[0].slice(0, 120),
      startLine: ln,
      endLine: ln,
    });
    if (/^export\s/.test(m[0])) pushRel("__file__", name, "EXPORTS", 1.0);
  }

  // --- class: class Name [extends Base] [implements I1, I2]
  const classRe = /(?:export\s+(?:default\s+)?)?(?:abstract\s+)?class\s+(\w+)(?:\s+extends\s+(\w+))?(?:\s+implements\s+([\w\s,]+))?/g;
  const classNames = new Set<string>();
  while ((m = classRe.exec(source)) !== null) {
    const [, name, base, impls] = m;
    classNames.add(name);
    const ln = lineOf(source, m.index);
    symbols.push({
      name,
      type: "class",
      signature: m[0].slice(0, 120),
      startLine: ln,
      endLine: ln,
    });
    if (base) pushRel(name, base, "EXTENDS", 1.0);
    if (impls)
      for (const i of impls.split(",")) {
        const t = i.trim();
        if (t) pushRel(name, t, "IMPLEMENTS", 1.0);
      }
    if (/^export\s/.test(m[0])) pushRel("__file__", name, "EXPORTS", 1.0);
  }

  // --- methods: inside classes — constructor / async name( / get name( / name = (
  const methodRe =
    /(?:^|\n)\s*(?:public|private|protected|static|async|override|readonly|\s)*\s*(?:get\s+|set\s+)?(\w+)\s*\([^)]*\)\s*(?::\s*[^{=;]+)?\s*\{/g;
  while ((m = methodRe.exec(source)) !== null) {
    const name = m[1];
    if (["if", "for", "while", "switch", "catch", "function"].includes(name)) continue;
    const ln = lineOf(source, m.index);
    symbols.push({
      name,
      type: "method",
      signature: m[0].trim().slice(0, 120),
      startLine: ln,
      endLine: ln,
    });
  }

  // --- interface / type
  const ifaceRe = /(?:export\s+)?interface\s+(\w+)/g;
  while ((m = ifaceRe.exec(source)) !== null) {
    const ln = lineOf(source, m.index);
    symbols.push({
      name: m[1],
      type: "interface",
      signature: m[0].slice(0, 120),
      startLine: ln,
      endLine: ln,
    });
  }
  const typeRe = /(?:export\s+)?type\s+(\w+)\s*=/g;
  while ((m = typeRe.exec(source)) !== null) {
    const ln = lineOf(source, m.index);
    symbols.push({
      name: m[1],
      type: "type",
      signature: m[0].slice(0, 120),
      startLine: ln,
      endLine: ln,
    });
  }

  // --- variables: top-level const/let/var not already function
  const varRe = /(?:export\s+)?(?:const|let|var)\s+(\w+)\s*[:=]/g;
  while ((m = varRe.exec(source)) !== null) {
    const name = m[1];
    if (funcNames.has(name)) continue;
    const ln = lineOf(source, m.index);
    symbols.push({
      name,
      type: "variable",
      signature: m[0].slice(0, 120),
      startLine: ln,
      endLine: ln,
    });
  }

  // --- calls: identifier( — attribute to enclosing function when determinable.
  // Run on string/comment-stripped source to avoid literals like "files (...)".
  const callSource = stripStringsAndComments(source);
  const callRe = /(\w+)\s*\(/g;
  const keywords = new Set([
    "if", "for", "while", "switch", "catch", "return", "function",
    "class", "import", "export", "new", "typeof", "instanceof",
  ]);
  // Order function symbols by line for enclosure lookup.
  const funcsByLine = symbols
    .filter((s) => s.type === "function" || s.type === "component" || s.type === "method")
    .sort((a, b) => a.startLine - b.startLine);
  let guard = 0;
  while ((m = callRe.exec(callSource)) !== null && guard++ < 4000) {
    const callee = m[1];
    if (keywords.has(callee)) continue;
    const ln = lineOf(callSource, m.index);
    let caller = "__file__";
    for (const f of funcsByLine) {
      if (f.startLine <= ln) caller = f.name;
      else break;
    }
    if (caller === callee) continue; // skip self-recursion noise at def line
    relations.push({
      from: caller,
      to: callee,
      rel: "CALLS",
      weight: WEIGHT.CALLS,
      confidence: 0.7, // regex can't resolve scope precisely
      methodCall: callSource[m.index - 1] === ".",
    });
  }

  return { symbols, relations };
}
