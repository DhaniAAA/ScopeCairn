// Adapter CALLS_API: edge lintas batas klien HTTP → simbol route.
// MVP: fetch, axios.*, ky, $fetch + instance axios.create di file JS/TS.
// URL: string literal, template literal, konkatenasi "+" dengan awalan statis.
// Target: simbol type='route' dari adapter nextjs/express/fastapi/nestjs/django.
// Tanpa tabel baru — edge sebagai relationships(type='CALLS_API') + evidence
// eksplisit (EXTRACTED/INFERRED/AMBIGUOUS). Kegagalan parse: log, jangan throw.

import type { DatabaseSync } from "node:sqlite";
import type { Node } from "web-tree-sitter";
import { withSyntaxTree } from "../treesitter.js";
import { grammarForPath } from "../extract/treeSitter.js";
import {
  WEIGHT,
  type EdgeEvidence,
} from "../extract/types.js";
import {
  enclosingFunction,
  fileSymbolOf,
  type QueryEdge,
} from "./types.js";
import { logError } from "../log.js";

export interface ApiCallSite {
  method: string;
  raw: string;
  normalized: string;
  line: number;
  index: number;
}

export interface ApiCallEdge extends QueryEdge {
  evidence: EdgeEvidence;
}

const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];
const CALL_METHODS = ["get", "post", "put", "patch", "delete", "head", "options", "request"];

export function apiCallsRelevant(rel: string): boolean {
  return /\.(js|ts|mjs|cjs|jsx|tsx)$/.test(rel);
}

/** Kanonik path URL klien maupun route tersimpan. Null bila tak dapat dinormalisasi. */
export function normalizeApiPath(raw: string): string | null {
  let s = raw.trim();
  if (!s) return null;
  if (/^ws(s)?:\/\//i.test(s)) return null;
  if (/^graphql\b/i.test(s)) return null;
  const origin = s.match(/^https?:\/\/[^/]+(.*)$/i);
  if (origin) s = origin[1] || "/";
  const cut = s.search(/[?#]/);
  if (cut !== -1) s = s.slice(0, cut);
  s = s.trim();
  if (!s) return null;
  // Pola regex Django re_path: ^api/...$, (?P<id>...), (?:...), \d+
  s = s.replace(/^\^/, "").replace(/\$$/, "");
  s = s
    .replace(/\(\?P<[^>]+>[^)]+\)/g, "{}")
    .replace(/\(\?:[^)]+\)/g, "{}")
    .replace(/\\d\+?/g, "{}");
  if (!s.startsWith("/")) s = "/" + s;
  s = s.replace(/\/{2,}/g, "/");
  const segs = s.split("/");
  const out: string[] = [];
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    if (i === 0) {
      out.push("");
      continue;
    }
    if (seg === "") continue;
    if (
      seg.includes("${") ||
      /^\$\{[^}]*\}$/.test(seg) ||
      /^\[.*\]$/.test(seg) ||
      /^:[^/]+$/.test(seg) ||
      /^<[^>]+>$/.test(seg) ||
      seg === "*" ||
      seg === "{}"
    ) {
      out.push("{}");
    } else {
      out.push(seg);
    }
  }
  let norm = out.join("/");
  if (!norm.startsWith("/")) norm = "/" + norm;
  if (norm.length > 1 && norm.endsWith("/")) norm = norm.slice(0, -1);
  if (!norm || norm === "/") return norm === "/" ? "/" : null;
  return norm;
}

/** Pecah nama simbol route ("GET /api/x", "ROUTE /p/", "PAGE /x", "API /x"). */
export function parseRouteName(name: string): { method: string | null; path: string } {
  const sp = name.indexOf(" ");
  if (sp === -1) return { method: null, path: name };
  const head = name.slice(0, sp).toUpperCase();
  const rest = name.slice(sp + 1);
  if ((HTTP_METHODS as string[]).includes(head)) return { method: head, path: rest };
  return { method: null, path: rest };
}

export function hasDynamicMarker(raw: string): boolean {
  return (
    raw.includes("${") ||
    /\[[^\]]+\]/.test(raw) ||
    /(^|\/):[^/]+/.test(raw) ||
    /<[^>]+>/.test(raw)
  );
}

/** Cocok segmen: sama persis, atau salah satu sisi `{}` (dinamis). */
export function matchSegments(routeNorm: string, callNorm: string): boolean {
  const a = routeNorm.split("/");
  const b = callNorm.split("/");
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] === b[i]) continue;
    if (a[i] === "{}" || b[i] === "{}") continue;
    return false;
  }
  return true;
}

function methodFromOptionsText(text: string): string | null {
  const m = text.match(/method\s*:\s*['"`](get|post|put|patch|delete|head|options)['"`]/i);
  return m ? m[1].toUpperCase() : null;
}

function axiosInstances(content: string): Set<string> {
  const out = new Set<string>();
  for (const re of [
    /(?:const|let|var)\s+(\w+)\s*=\s*axios\.create\s*\(/g,
    /(\w+)\s*=\s*axios\.create\s*\(/g,
    /(?:const|let|var)\s+(\w+)\s*=\s*ky\.(?:create|extend)\s*\(/g,
  ]) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(content)) !== null) out.add(m[1]);
  }
  return out;
}

function staticPrefix(node: Node): string | null {
  if (node.type === "string") {
    return node.text.length >= 2 ? node.text.slice(1, -1) : null;
  }
  if (node.type === "template_string") {
    return node.text.length >= 2 ? node.text.slice(1, -1) : null;
  }
  // Konkatenasi "a" + x + "b": ambil literal string/template pertama.
  const stack: Node[] = [node];
  while (stack.length > 0) {
    const cur = stack.shift()!;
    if (cur.type === "string" || cur.type === "template_string") {
      const v = cur.text.length >= 2 ? cur.text.slice(1, -1) : "";
      if (v) return v;
    }
    for (const c of cur.namedChildren) if (c) stack.push(c);
  }
  return null;
}

/** Detector murni: tanpa DB write, tanpa throw (return [] saat grammar belum siap). */
export function parseApiCalls(content: string, grammar: string): ApiCallSite[] {
  let instances: Set<string>;
  try {
    instances = axiosInstances(content);
  } catch {
    instances = new Set();
  }
  try {
    return withSyntaxTree(grammar, content, (root) => {
      const out: ApiCallSite[] = [];
      const visit = (node: Node): void => {
        if (node.type === "call_expression") {
          const callee = node.childForFieldName("function");
          const argsNode = node.childForFieldName("arguments");
          const args = argsNode?.namedChildren.filter((c): c is Node => !!c) ?? [];
          if (callee && args.length > 0) {
            let method: string | null = null;
            let urlNode: Node | null = null;
            let allowed = false;
            if (callee.type === "identifier") {
              const name = callee.text;
              if (name === "fetch" || name === "$fetch") {
                allowed = true;
                method = null;
                urlNode = args[0];
                if (args[1]) method = methodFromOptionsText(args[1].text);
                if (!method) method = "GET";
              } else if (name === "axios") {
                // axios("/url") atau axios({url, method})
                allowed = true;
                const first = args[0];
                if (first.type === "object" || first.type === "object_expression") {
                  const t = first.text;
                  const um = t.match(/url\s*:\s*['"`]([^'"`]+)['"`]/);
                  if (!um) {
                    // tak ada url literal — lewati
                  } else {
                    method = methodFromOptionsText(t) ?? "GET";
                    const raw = um[1];
                    const normalized = normalizeApiPath(raw);
                    if (normalized && raw.includes("/")) {
                      out.push({
                        method,
                        raw,
                        normalized,
                        line: node.startPosition.row + 1,
                        index: node.startIndex,
                      });
                    }
                  }
                } else {
                  method = "GET";
                  urlNode = first;
                }
                if (urlNode) {
                  const raw = staticPrefix(urlNode);
                  if (raw !== null) {
                    const normalized = normalizeApiPath(raw);
                    if (normalized && raw.includes("/")) {
                      out.push({ method: method ?? "GET", raw, normalized, line: node.startPosition.row + 1, index: node.startIndex });
                    }
                  }
                }
                urlNode = null; // sudah ditangani
              }
            } else if (callee.type === "member_expression") {
              const obj = callee.childForFieldName("object")?.text;
              const prop = callee.childForFieldName("property")?.text;
              if (obj && prop && CALL_METHODS.includes(prop)) {
                if (
                  obj === "axios" ||
                  obj === "ky" ||
                  obj === "$fetch" ||
                  instances.has(obj)
                ) {
                  allowed = true;
                  method = prop === "request" ? null : prop.toUpperCase();
                  urlNode = args[0];
                  if (!method && args[1]) method = methodFromOptionsText(args[1].text);
                  if (!method) method = "GET";
                }
              }
            }
            if (allowed && urlNode) {
              const raw = staticPrefix(urlNode);
              if (raw !== null && raw !== "") {
                const trimmed = raw.trim();
                // Filter false positive: butuh "/" (bunuh Map.get("key"), cache.get(k)).
                // URL dinamis penuh (identifier tanpa slash) dilewati tanpa error.
                if (trimmed.includes("/")) {
                  let normalized = normalizeApiPath(trimmed);
                  // Konkatenasi "/api/users/" + id: awalan statis kehilangan segmen
                  // dinamis → tambah satu {} agar cocok pola route [id]/:id.
                  // Hanya bila prefix berakhir "/" (jelas ada segmen dinamis di belakang).
                  if (
                    normalized &&
                    (urlNode.type === "binary_expression" || urlNode.text.includes("+")) &&
                    !hasDynamicMarker(trimmed) &&
                    !normalized.endsWith("/{}") &&
                    trimmed.endsWith("/")
                  ) {
                    const withDyn = normalizeApiPath(normalized + "/{}");
                    if (withDyn) normalized = withDyn;
                  }
                  if (normalized) {
                    out.push({
                      method: method ?? "GET",
                      raw: trimmed,
                      normalized,
                      line: node.startPosition.row + 1,
                      index: node.startIndex,
                    });
                  }
                }
              }
            }
          }
        }
        for (const child of node.namedChildren) if (child) visit(child);
      };
      visit(root);
      return out;
    });
  } catch {
    return [];
  }
}

/** Resolver: cocokkan call site ke simbol route. Tanpa throw; parse gagal → []. */
export function deriveApiCalls(
  db: DatabaseSync,
  fileId: number,
  content: string,
  rel: string
): ApiCallEdge[] {
  const out: ApiCallEdge[] = [];
  let grammar: string | null;
  try {
    grammar = grammarForPath(rel);
  } catch (err) {
    logError("adapters", err);
    return out;
  }
  if (!grammar || !["typescript", "tsx", "javascript"].includes(grammar)) return out;
  let calls: ApiCallSite[];
  try {
    calls = parseApiCalls(content, grammar);
  } catch (err) {
    logError("adapters", err);
    return out;
  }
  if (calls.length === 0) return out;
  let routes: { id: number; name: string }[];
  try {
    routes = db
      .prepare(`SELECT id, name FROM symbols WHERE type = 'route'`)
      .all() as { id: number; name: string }[];
  } catch (err) {
    logError("adapters", err);
    return out;
  }
  if (routes.length === 0) return out;
  const normRoutes: { id: number; method: string | null; normalized: string; rawPath: string }[] = [];
  for (const r of routes) {
    try {
      const parsed = parseRouteName(r.name);
      const normalized = normalizeApiPath(parsed.path);
      if (normalized) normRoutes.push({ id: r.id, method: parsed.method, normalized, rawPath: parsed.path });
    } catch {
      continue;
    }
  }
  if (normRoutes.length === 0) return out;
  const fileSym = fileSymbolOf(db, fileId);
  for (const call of calls) {
    try {
      const pathMatch = (r: { normalized: string }): boolean =>
        matchSegments(r.normalized, call.normalized);
      const exact = normRoutes.filter(
        (r) => pathMatch(r) && (r.method === null || r.method === call.method)
      );
      const methodMismatch =
        exact.length === 0
          ? normRoutes.filter((r) => pathMatch(r)).slice(0, 3)
          : [];
      const picked: { id: number; confidence: number; evidence: EdgeEvidence }[] = [];
      if (exact.length === 1) {
        const literal =
          !hasDynamicMarker(call.raw) &&
          normalizeApiPath(normRoutes.find((r) => r.id === exact[0].id)?.rawPath ?? "") === call.normalized &&
          (exact[0].rawPath === call.raw || exact[0].rawPath.replace(/\/$/, "") === call.raw.replace(/\/$/, ""));
        if (literal) picked.push({ id: exact[0].id, confidence: 1.0, evidence: "EXTRACTED" });
        else picked.push({ id: exact[0].id, confidence: 0.8, evidence: "INFERRED" });
      } else if (exact.length > 1) {
        const confs = [0.5, 0.4, 0.3];
        exact.slice(0, 3).forEach((r, i) => picked.push({ id: r.id, confidence: confs[i], evidence: "AMBIGUOUS" }));
      } else if (methodMismatch.length > 0) {
        for (const r of methodMismatch) picked.push({ id: r.id, confidence: 0.4, evidence: "AMBIGUOUS" });
      } else {
        continue; // belum ter-resolve: tidak disimpan (post-pass berikutnya mencoba lagi)
      }
      const caller = enclosingFunction(db, fileId, call.line) ?? fileSym;
      if (!caller) continue;
      for (const p of picked) {
        if (caller === p.id) continue;
        out.push({ callerId: caller, targetId: p.id, weight: WEIGHT.CALLS_API, confidence: p.confidence, evidence: p.evidence });
      }
    } catch (err) {
      logError("adapters", err);
      continue;
    }
  }
  return out;
}
