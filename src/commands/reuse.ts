import type { DatabaseSync } from "node:sqlite";
import { openDb } from "../db.js";
import { logInvocation } from "../invocations.js";
import { refreshIndex } from "../refresh.js";
import { skipRefresh } from "./opts.js";
import { tokenizeIdentifier } from "../retrieval/tokenize.js";
import { loadGlossary } from "../retrieval/config.js";
import { seedSearch } from "../retrieval/symbolIndex.js";
import { isTestPath } from "../retrieval/retrieve.js";

export interface ReuseOptions {
  json?: boolean;
  limit?: number;
  noRefresh?: boolean;
  refresh?: boolean;
}

export interface ParsedSignature {
  hasSignatureSyntax: boolean;
  arity: number | null;
  paramTypes: string[];
  returnType: string | null;
}

export interface ReuseCandidate {
  path: string;
  startLine: number;
  endLine: number;
  name: string;
  type: string;
  signature: string;
  exported: boolean;
  score: number;
  reasons: string[];
}

export interface ReuseResult {
  query: string;
  empty: boolean;
  candidates: ReuseCandidate[];
}

const REUSABLE_TYPES = new Set([
  "function",
  "class",
  "method",
  "component",
  "interface",
  "type",
]);

function normalizeTypeToken(raw: string): string {
  return raw
    .replace(/\bPromise\s*<\s*(.+?)\s*>/i, "$1")
    .replace(/\bReadonly\s*<\s*(.+?)\s*>/i, "$1")
    .replace(/\[\]$/g, "array")
    .replace(/[^a-zA-Z0-9_|]/g, "")
    .toLowerCase();
}

/**
 * Ekstrak struktur signature dari teks query atau deklarasi simbol:
 * arity (jumlah parameter), daftar tipe parameter, dan tipe kembalian.
 */
export function parseSignatureHint(text: string): ParsedSignature {
  const clean = text.replace(/\s+/g, " ").trim();
  const parenStart = clean.indexOf("(");
  if (parenStart === -1) {
    // Cek bentuk panah tanpa kurung: `x: string => number`
    const arrowMatch = clean.match(/:\s*([A-Za-z0-9_<>[\]|]+)\s*(?:=>|->)\s*([A-Za-z0-9_<>[\]|]+)/);
    if (arrowMatch) {
      return {
        hasSignatureSyntax: true,
        arity: 1,
        paramTypes: [normalizeTypeToken(arrowMatch[1])].filter(Boolean),
        returnType: normalizeTypeToken(arrowMatch[2]) || null,
      };
    }
    return { hasSignatureSyntax: false, arity: null, paramTypes: [], returnType: null };
  }

  let depth = 0;
  let parenEnd = -1;
  for (let i = parenStart; i < clean.length; i++) {
    const ch = clean[i];
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) {
        parenEnd = i;
        break;
      }
    }
  }
  if (parenEnd === -1) {
    return { hasSignatureSyntax: false, arity: null, paramTypes: [], returnType: null };
  }

  const inside = clean.slice(parenStart + 1, parenEnd).trim();
  const params: string[] = [];
  if (inside.length > 0) {
    let angle = 0;
    let cur = "";
    for (const ch of inside) {
      if (ch === "<" || ch === "(" || ch === "[") angle++;
      else if (ch === ">" || ch === ")" || ch === "]") angle = Math.max(0, angle - 1);
      if (ch === "," && angle === 0) {
        params.push(cur.trim());
        cur = "";
      } else {
        cur += ch;
      }
    }
    if (cur.trim()) params.push(cur.trim());
  }

  const filteredParams = params.filter((p) => p !== "self" && p !== "this");
  const paramTypes: string[] = [];
  for (const p of filteredParams) {
    const colon = p.indexOf(":");
    if (colon !== -1) {
      const tPart = p.slice(colon + 1).split("=")[0].trim();
      const norm = normalizeTypeToken(tPart);
      if (norm) paramTypes.push(norm);
    } else {
      // Go / Java / C style: `name Type` atau `Type name`
      const parts = p.split(/\s+/).filter(Boolean);
      if (parts.length === 2) {
        const norm = normalizeTypeToken(parts[1]);
        if (norm) paramTypes.push(norm);
      }
    }
  }

  const after = clean.slice(parenEnd + 1).trim();
  let returnType: string | null = null;
  const retMatch = after.match(/^(?::|->|=>)\s*([A-Za-z0-9_<>[\]|.\s]+?)(?:\s*\{|\s*;|\s*$)/);
  if (retMatch && retMatch[1]) {
    const norm = normalizeTypeToken(retMatch[1]);
    if (norm && norm !== "void") returnType = norm;
    else if (norm === "void") returnType = "void";
  }

  return {
    hasSignatureSyntax: true,
    arity: filteredParams.length,
    paramTypes,
    returnType,
  };
}

function expandWithGlossary(tokens: string[], glossary: Map<string, string[]>): string[] {
  const out = new Set(tokens);
  for (const t of tokens) {
    for (const a of glossary.get(t) ?? []) out.add(a);
    for (const [term, aliases] of glossary) {
      if (aliases.includes(t)) out.add(term);
    }
  }
  return [...out];
}

export function searchReuse(
  db: DatabaseSync,
  repoRoot: string,
  query: string,
  limit = 10
): ReuseResult {
  const trimmed = query.trim();
  if (!trimmed) {
    return { query, empty: true, candidates: [] };
  }

  const rawTokens = tokenizeIdentifier(trimmed);
  const glossary = loadGlossary(repoRoot);
  const queryTokens = expandWithGlossary(rawTokens, glossary);
  const queryTokenSet = new Set(queryTokens);
  const querySig = parseSignatureHint(trimmed);

  // 1. Ambil kandidat dari FTS5 + scan tabel symbols untuk signature match
  const ftsHits = seedSearch(db, queryTokens, 80);
  const ftsMap = new Map<number, number>(ftsHits.map((h) => [h.symbolId, h.bm25]));

  const allSymbols = db
    .prepare(
      `SELECT s.id, s.name, s.type, s.signature, s.start_line AS startLine, s.end_line AS endLine,
              s.doc, f.path AS path, f.id AS fileId
       FROM symbols s
       JOIN files f ON f.id = s.file_id
       WHERE s.type IN ('function', 'class', 'method', 'component', 'interface', 'type')`
    )
    .all() as {
    id: number;
    name: string;
    type: string;
    signature: string;
    startLine: number;
    endLine: number;
    doc: string;
    path: string;
    fileId: number;
  }[];

  // Himpun simbol yang di-export (memiliki edge EXPORTS dari file-symbol)
  const exportedRows = db
    .prepare(
      `SELECT target_id AS id FROM relationships WHERE relationship_type = 'EXPORTS'`
    )
    .all() as { id: number }[];
  const exportedIds = new Set<number>(exportedRows.map((r) => r.id));

  // Himpun tetangga call graph & type graph untuk kandidat potensial
  const neighborNamesStmt = db.prepare(
    `SELECT DISTINCT s.name AS name, r.relationship_type AS rel, 'out' AS dir
     FROM relationships r
     JOIN symbols s ON s.id = r.target_id
     WHERE r.source_id = ? AND r.relationship_type IN ('CALLS', 'PARAM_TYPE', 'RETURN_TYPE', 'IMPLEMENTS', 'EXTENDS')
     UNION
     SELECT DISTINCT s.name AS name, r.relationship_type AS rel, 'in' AS dir
     FROM relationships r
     JOIN symbols s ON s.id = r.source_id
     WHERE r.target_id = ? AND r.relationship_type IN ('CALLS', 'PARAM_TYPE', 'RETURN_TYPE', 'IMPLEMENTS', 'EXTENDS')
     LIMIT 30`
  );

  const scored: ReuseCandidate[] = [];

  for (const sym of allSymbols) {
    if (!REUSABLE_TYPES.has(sym.type)) continue;
    if (isTestPath(sym.path)) continue;

    const reasons: string[] = [];

    // Sinyal 1: Token nama (camelCase dipecah)
    const nameTokens = tokenizeIdentifier(sym.name);
    const matchedNameTokens = nameTokens.filter((t) => queryTokenSet.has(t));
    let nameScore = 0;
    if (sym.name.toLowerCase() === trimmed.toLowerCase()) {
      nameScore = 1.0;
      reasons.push(`exact name "${sym.name}"`);
    } else if (matchedNameTokens.length > 0) {
      const recall = matchedNameTokens.length / Math.max(1, Math.min(rawTokens.length || 1, nameTokens.length));
      const precision = matchedNameTokens.length / Math.max(1, nameTokens.length);
      nameScore = Math.min(1, recall * 0.65 + precision * 0.35);
      reasons.push(`name tokens (${matchedNameTokens.slice(0, 4).join(", ")})`);
    }

    // Sinyal 2: Kemiripan signature (jumlah & tipe parameter, tipe kembalian)
    let sigScore = 0;
    const symSig = parseSignatureHint(sym.signature);
    if (querySig.hasSignatureSyntax && symSig.hasSignatureSyntax) {
      const sigMatches: string[] = [];
      if (querySig.arity !== null && symSig.arity !== null) {
        if (querySig.arity === symSig.arity) {
          sigScore += 0.35;
          sigMatches.push(`arity=${symSig.arity}`);
        } else if (Math.abs(querySig.arity - symSig.arity) === 1) {
          sigScore += 0.15;
        }
      }
      if (querySig.paramTypes.length > 0 && symSig.paramTypes.length > 0) {
        const symPSet = new Set(symSig.paramTypes);
        const hitP = querySig.paramTypes.filter((t) => symPSet.has(t));
        if (hitP.length > 0) {
          sigScore += 0.35 * (hitP.length / querySig.paramTypes.length);
          sigMatches.push(`params(${hitP.join(",")})`);
        }
      }
      if (querySig.returnType && symSig.returnType) {
        if (
          querySig.returnType === symSig.returnType ||
          symSig.returnType.includes(querySig.returnType) ||
          querySig.returnType.includes(symSig.returnType)
        ) {
          sigScore += 0.3;
          sigMatches.push(`return=${symSig.returnType}`);
        }
      }
      if (sigMatches.length > 0) {
        reasons.push(`signature (${sigMatches.join(", ")})`);
      }
    } else if (sym.signature && queryTokens.length > 0) {
      const sigTokens = tokenizeIdentifier(sym.signature);
      const sigTokenHits = sigTokens.filter((t) => queryTokenSet.has(t) && !nameTokens.includes(t));
      if (sigTokenHits.length > 0) {
        sigScore = Math.min(0.6, sigTokenHits.length * 0.2);
        reasons.push(`signature tokens (${sigTokenHits.slice(0, 3).join(", ")})`);
      }
    }

    // Sinyal 3: Doc comment
    let docScore = 0;
    if (sym.doc && queryTokens.length > 0) {
      const docTokens = tokenizeIdentifier(sym.doc);
      const docHits = docTokens.filter((t) => queryTokenSet.has(t));
      if (docHits.length > 0) {
        docScore = Math.min(1, docHits.length / Math.max(2, Math.min(5, rawTokens.length || 2)));
        reasons.push(`doc comment (${docHits.slice(0, 4).join(", ")})`);
      }
    }

    // Optimasi: hanya query call graph bila ada minimal indikasi awal (FTS, nama, sig, atau doc)
    const ftsBm25 = ftsMap.get(sym.id) ?? 0;
    if (nameScore === 0 && sigScore === 0 && docScore === 0 && ftsBm25 === 0) {
      continue;
    }

    // Sinyal 4: Tetangga di call graph & type graph
    let neighborScore = 0;
    const neighbors = neighborNamesStmt.all(sym.id, sym.id) as {
      name: string;
      rel: string;
      dir: string;
    }[];
    const matchedNeighbors: string[] = [];
    for (const nb of neighbors) {
      const nbToks = tokenizeIdentifier(nb.name);
      if (nbToks.some((t) => queryTokenSet.has(t))) {
        matchedNeighbors.push(nb.name);
      } else if (
        querySig.hasSignatureSyntax &&
        (nb.rel === "PARAM_TYPE" || nb.rel === "RETURN_TYPE")
      ) {
        const normNb = normalizeTypeToken(nb.name);
        if (
          querySig.paramTypes.includes(normNb) ||
          (querySig.returnType && querySig.returnType.includes(normNb))
        ) {
          matchedNeighbors.push(nb.name);
        }
      }
    }
    if (matchedNeighbors.length > 0) {
      const uniqNb = [...new Set(matchedNeighbors)];
      neighborScore = Math.min(1, uniqNb.length * 0.35);
      reasons.push(`call-graph neighbors (${uniqNb.slice(0, 3).join(", ")})`);
    }

    const exported = exportedIds.has(sym.id) || /^export\b/.test(sym.signature.trim());

    // Gabungkan 4 sinyal utama + bonus export kecil
    const totalScore = querySig.hasSignatureSyntax
      ? nameScore * 0.25 + sigScore * 0.45 + docScore * 0.15 + neighborScore * 0.15 + (exported ? 0.04 : 0)
      : nameScore * 0.45 + sigScore * 0.15 + docScore * 0.25 + neighborScore * 0.15 + (exported ? 0.04 : 0);

    if (totalScore < 0.12 || reasons.length === 0) continue;

    scored.push({
      path: sym.path,
      startLine: sym.startLine,
      endLine: sym.endLine,
      name: sym.name,
      type: sym.type,
      signature: sym.signature,
      exported,
      score: Number(Math.min(1, totalScore).toFixed(3)),
      reasons,
    });
  }

  scored.sort((a, b) => b.score - a.score || (b.exported ? 1 : 0) - (a.exported ? 1 : 0) || a.name.localeCompare(b.name));
  const top = scored.slice(0, Math.max(1, Math.min(50, limit)));

  return {
    query,
    empty: top.length === 0,
    candidates: top,
  };
}

export async function cmdReuse(
  repoRoot: string,
  query: string,
  opts: ReuseOptions = {}
): Promise<void> {
  if (!skipRefresh(opts)) {
    try {
      await refreshIndex(repoRoot);
    } catch {
      // best-effort refresh
    }
  }

  const db = openDb(repoRoot);
  try {
    logInvocation(db, "reuse");
    const res = searchReuse(db, repoRoot, query, opts.limit ?? 10);

    if (opts.json) {
      console.log(JSON.stringify(res, null, 2));
      return;
    }

    console.log(`# ScopeCairn Reuse Check\n`);
    console.log(`Query: "${query}"\n`);

    if (res.empty) {
      console.log(`Tidak ditemukan function atau class yang mirip di index untuk "${query}".`);
      console.log(`Aman membuat simbol baru bila memang dibutuhkan oleh task.`);
      return;
    }

    console.log(`Kandidat untuk dipakai ulang (${res.candidates.length}):\n`);
    for (let i = 0; i < res.candidates.length; i++) {
      const c = res.candidates[i];
      const expLabel = c.exported ? "exported" : "internal";
      const sig = c.signature ? ` — \`${c.signature}\`` : "";
      console.log(
        `${i + 1}. **${c.name}** (${c.type}, ${expLabel}) — \`${c.path}:${c.startLine}-${c.endLine}\` [score=${c.score.toFixed(2)}]${sig}`
      );
      console.log(`   Alasan: ${c.reasons.join("; ")}`);
    }
  } finally {
    db.close();
  }
}
