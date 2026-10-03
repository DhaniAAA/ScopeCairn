import { WEIGHT, type FileExtraction, type RelationType } from "./types.js";

function lineOf(text: string, index: number): number {
  return text.slice(0, index).split("\n").length;
}

// Minimal Python extractor: import, def, class, calls.
export function extractPython(source: string): FileExtraction {
  const symbols: FileExtraction["symbols"] = [];
  const relations: FileExtraction["relations"] = [];
  const push = (
    from: string,
    to: string,
    rel: RelationType,
    confidence = 1.0
  ) => relations.push({ from, to, rel, weight: WEIGHT[rel], confidence });

  let m: RegExpExecArray | null;
  const importRe = /^\s*(?:import\s+([\w.,\s]+)|from\s+([\w.]+)\s+import\s+([^\n#]+))/gm;
  while ((m = importRe.exec(source)) !== null) {
    const mod = (m[2] ?? m[1] ?? "").trim();
    if (!mod) continue;
    const ln = lineOf(source, m.index);
    symbols.push({
      name: `import:${mod}`,
      type: "import",
      signature: m[0].trim().slice(0, 120),
      startLine: ln,
      endLine: ln,
    });
    push("__file__", mod, "IMPORTS", 1.0);
  }

  const classRe = /^\s*class\s+(\w+)(?:\s*\(([^)]*)\))?\s*:/gm;
  while ((m = classRe.exec(source)) !== null) {
    const ln = lineOf(source, m.index);
    symbols.push({
      name: m[1],
      type: "class",
      signature: m[0].trim().slice(0, 120),
      startLine: ln,
      endLine: ln,
    });
    const bases = (m[2] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    for (const b of bases) {
      if (!["object"].includes(b)) push(m[1], b, "EXTENDS", 0.9);
    }
  }

  const defRe = /^\s*(?:async\s+)?def\s+(\w+)\s*\(/gm;
  const funcs: { name: string; line: number }[] = [];
  while ((m = defRe.exec(source)) !== null) {
    const ln = lineOf(source, m.index);
    const indented = /^\s+/.test(m[0]);
    symbols.push({
      name: m[1],
      type: indented ? "method" : "function",
      signature: m[0].trim().slice(0, 120),
      startLine: ln,
      endLine: ln,
    });
    funcs.push({ name: m[1], line: ln });
  }
  funcs.sort((a, b) => a.line - b.line);

  const callRe = /(\w+)\s*\(/g;
  const kw = new Set(["def", "class", "if", "for", "while", "return", "import", "print"]);
  let guard = 0;
  while ((m = callRe.exec(source)) !== null && guard++ < 4000) {
    const callee = m[1];
    if (kw.has(callee)) continue;
    const ln = lineOf(source, m.index);
    let caller = "__file__";
    for (const f of funcs) {
      if (f.line <= ln) caller = f.name;
      else break;
    }
    if (caller === callee) continue;
    relations.push({
      from: caller,
      to: callee,
      rel: "CALLS",
      weight: WEIGHT.CALLS,
      confidence: 0.7,
      methodCall: source[m.index - 1] === ".",
    });
  }

  return { symbols, relations };
}
