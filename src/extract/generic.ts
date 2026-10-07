import { WEIGHT, type FileExtraction, type RelationType } from "./types.js";
import type { SourceLanguage } from "../languages.js";

// Extractor generik untuk bahasa di luar TypeScript/Python (FR-01: Java,
// Go, Rust, PHP, C#, C/C++, Ruby, HTML). Heuristik regex per keluarga —
// presisi di bawah parser khusus, ditandai confidence < 1.0.
// Tree-sitter per bahasa menancap di dispatcher tanpa mengubah bentuk ini.

function lineOf(text: string, index: number): number {
  return text.slice(0, index).split("\n").length;
}

// Samarkan string + komentar, pertahankan newline (untuk deteksi CALLS).
function stripNoise(src: string): string {
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
    if (c === "#") {
      // Komentar gaya # (Ruby; di C-like jarang di awal logika).
      while (i < src.length && src[i] !== "\n") {
        out += " ";
        i++;
      }
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

const CALL_KEYWORDS = new Set([
  "if", "for", "while", "switch", "catch", "return", "function",
  "class", "import", "export", "new", "typeof", "instanceof",
  "def", "fn", "func", "elsif", "unless", "sizeof",
]);

export function extractGeneric(source: string, lang: SourceLanguage): FileExtraction {
  const symbols: FileExtraction["symbols"] = [];
  const relations: FileExtraction["relations"] = [];
  const pushRel = (from: string, to: string, rel: RelationType, confidence = 1.0) =>
    relations.push({ from, to, rel, weight: WEIGHT[rel], confidence });

  let m: RegExpExecArray | null;

  // --- imports
  const importLine = /^\s*import\s+(.+?)\s*$/gm;
  while ((m = importLine.exec(source)) !== null) {
    // Go: `import f "fmt"` — ambil path paket dalam kutip, bukan alias.
    const goPath = lang === "go" ? m[1].match(/["`]([^"`]+)["`]/) : null;
    const mod = (goPath ? goPath[1] : m[1].replace(/["';]/g, "").trim().split(/\s+/)[0]);
    if (!mod || mod === "*") continue;
    const ln = lineOf(source, m.index);
    symbols.push({ name: `import:${mod}`, type: "import", signature: m[0].trim().slice(0, 120), startLine: ln, endLine: ln });
    pushRel("__file__", mod, "IMPORTS", 0.8);
  }
  if (lang === "c" || lang === "cpp" || lang === "csharp") {
    const incRe = /#include\s+[<"]([^>"]+)[>"]/g;
    while ((m = incRe.exec(source)) !== null) {
      const ln = lineOf(source, m.index);
      symbols.push({ name: `import:${m[1]}`, type: "import", signature: m[0].slice(0, 120), startLine: ln, endLine: ln });
      pushRel("__file__", m[1], "IMPORTS", 0.8);
    }
  }
  if (lang === "php" || lang === "rust") {
    const useRe = lang === "php" ? /^\s*use\s+([\w\\]+)\s*;/gm : /^\s*use\s+([\w:]+)(?:::\s*\{[^}]*\})?\s*;/gm;
    while ((m = useRe.exec(source)) !== null) {
      const ln = lineOf(source, m.index);
      symbols.push({ name: `import:${m[1]}`, type: "import", signature: m[0].trim().slice(0, 120), startLine: ln, endLine: ln });
      pushRel("__file__", m[1], "IMPORTS", 0.8);
    }
  }
  if (lang === "go") {
    // import "fmt" dan blok import ( ... ).
    const goImp = /^\s*(?:(\w+)\s+)?["`]([^"`]+)["`]/gm;
    const block = /^\s*import\s*\(\s*$/gm;
    let b: RegExpExecArray | null;
    while ((b = block.exec(source)) !== null) {
      const end = source.indexOf(")", b.index);
      const body = source.slice(b.index, end === -1 ? b.index + 500 : end);
      let im: RegExpExecArray | null;
      goImp.lastIndex = 0;
      while ((im = goImp.exec(body)) !== null) {
        const mod = im[2];
        const ln = lineOf(source, b.index);
        symbols.push({ name: `import:${mod}`, type: "import", signature: mod.slice(0, 120), startLine: ln, endLine: ln });
        pushRel("__file__", mod, "IMPORTS", 0.9);
      }
    }
  }

  // --- class / struct / interface / trait / enum
  const classRe = /(?:class|struct|interface|trait|enum)\s+(\w+)/g;
  const classNames = new Set<string>();
  while ((m = classRe.exec(source)) !== null) {
    classNames.add(m[1]);
    const ln = lineOf(source, m.index);
    symbols.push({ name: m[1], type: "class", signature: m[0].slice(0, 120), startLine: ln, endLine: ln });
  }
  if (lang === "go") {
    const typeRe = /^\s*type\s+(\w+)\s+(struct|interface)\b/gm;
    while ((m = typeRe.exec(source)) !== null) {
      if (classNames.has(m[1])) continue;
      classNames.add(m[1]);
      const ln = lineOf(source, m.index);
      symbols.push({ name: m[1], type: "class", signature: m[0].trim().slice(0, 120), startLine: ln, endLine: ln });
    }
  }

  // --- functions
  const funcNames = new Set<string>();
  const addFunc = (name: string, sig: string, idx: number, type: "function" | "method" = "function") => {
    if (CALL_KEYWORDS.has(name) || classNames.has(name)) return;
    funcNames.add(name);
    const ln = lineOf(source, idx);
    symbols.push({ name, type, signature: sig.slice(0, 120), startLine: ln, endLine: ln });
  };
  if (lang === "go") {
    const re = /func\s+(?:\([^)]*\)\s+)?(\w+)\s*\(/g;
    while ((m = re.exec(source)) !== null) addFunc(m[1], m[0], m.index);
  } else if (lang === "rust") {
    const re = /fn\s+(\w+)\s*[<(]/g;
    while ((m = re.exec(source)) !== null) addFunc(m[1], m[0], m.index);
  } else if (lang === "ruby") {
    const re = /^\s*def\s+([\w.]+)/gm;
    while ((m = re.exec(source)) !== null) addFunc(m[1], m[0].trim(), m.index);
  } else {
    // Keluarga C-like: nama(...) { — butuh kurung kurawal pembuka.
    const re = /(?:^|[{};\n])\s*(?:[\w<>\[\],\s*&:|?]+\s+)?(\w+)\s*\([^();]*\)\s*(?:throws\s+[\w,\s]+)?\{/gm;
    while ((m = re.exec(source)) !== null) {
      if (m[0].includes(".") && !m[0].trimStart().startsWith(m[1])) continue;
      addFunc(m[1], m[0].trim(), m.index);
    }
  }

  // --- calls pada source yang sudah disamarkan
  const clean = stripNoise(source);
  const funcsByLine = symbols
    .filter((s) => s.type === "function" || s.type === "method")
    .sort((a, b) => a.startLine - b.startLine);
  const callRe = /(\w+)\s*\(/g;
  let guard = 0;
  while ((m = callRe.exec(clean)) !== null && guard++ < 4000) {
    const callee = m[1];
    if (CALL_KEYWORDS.has(callee)) continue;
    const ln = lineOf(clean, m.index);
    let caller = "__file__";
    for (const f of funcsByLine) {
      if (f.startLine <= ln) caller = f.name;
      else break;
    }
    if (caller === callee) continue;
    relations.push({
      from: caller,
      to: callee,
      rel: "CALLS",
      weight: WEIGHT.CALLS,
      confidence: 0.6,
      methodCall: clean[m.index - 1] === ".",
    });
  }

  return { symbols, relations };
}

/** HTML: element ber-id + referensi script/link. */
export function extractHtml(source: string): FileExtraction {
  const symbols: FileExtraction["symbols"] = [];
  const relations: FileExtraction["relations"] = [];
  let m: RegExpExecArray | null;
  const idRe = /<(\w+)[^>]*\sid\s*=\s*["']([^"']+)["']/gi;
  while ((m = idRe.exec(source)) !== null) {
    const ln = lineOf(source, m.index);
    symbols.push({
      name: m[2],
      type: "element",
      signature: `<${m[1]} id="${m[2]}">`.slice(0, 120),
      startLine: ln,
      endLine: ln,
    });
  }
  const refRe = /<(script|link)[^>]*(src|href)\s*=\s*["']([^"']+)["']/gi;
  while ((m = refRe.exec(source)) !== null) {
    const ln = lineOf(source, m.index);
    symbols.push({
      name: `import:${m[3]}`,
      type: "import",
      signature: m[0].slice(0, 120),
      startLine: ln,
      endLine: ln,
    });
    relations.push({ from: "__file__", to: m[3], rel: "IMPORTS", weight: WEIGHT.IMPORTS, confidence: 0.7 });
  }
  return { symbols, relations };
}
