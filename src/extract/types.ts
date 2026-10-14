// PRD FR-02 / FR-03 types. Contract consumed by the Tree-sitter extractor
// (src/extract/treeSitter.ts) without changing consumers downstream.

export type SymbolType =
  | "file"
  | "function"
  | "class"
  | "method"
  | "variable"
  | "import"
  | "export"
  | "interface"
  | "type"
  | "component"
  | "route"
  | "model"
  | "element";

export type RelationType =
  | "CONTAINS"
  | "IMPORTS"
  | "EXPORTS"
  | "CALLS"
  | "EXTENDS"
  | "IMPLEMENTS"
  | "REFERENCES"
  | "USES"
  | "TESTS"
  | "ROUTES_TO"
  | "QUERIES"
  | "CALLS_API"
  | "PARAM_TYPE"
  | "RETURN_TYPE"
  | "TYPED_AS";

export interface ExtractedSymbol {
  name: string;
  type: SymbolType;
  signature: string;
  startLine: number;
  endLine: number;
  /** Docstring/komentar utama tepat di atas deklarasi, bila ada. */
  doc?: string;
}

export interface ExtractedImport {
  localName: string;
  importedName: string;
  moduleSpecifier: string;
}

export interface RawRelation {
  from: string;
  fromType?: SymbolType;
  to: string;
  rel: RelationType;
  weight: number;
  confidence: number;
  /** True bila call site berbentuk `obj.name(` — resolusi dibatasi ke method. */
  methodCall?: boolean;
  /** Receiver objek/namespace (mis. `obj` pada `obj.func()` atau `pkg` pada `pkg.Func()`). */
  receiver?: string;
  /** Tipe semantik receiver bila berhasil diinferensi dari parameter/variabel lokal. */
  receiverType?: string;
}

export interface FileExtraction {
  symbols: ExtractedSymbol[];
  relations: RawRelation[];
  imports?: ExtractedImport[];
}

export type EdgeEvidence = "EXTRACTED" | "INFERRED" | "AMBIGUOUS";

/** Kesan kejujuran tepi: hasil parse langsung vs inferensi vs ambigu. */
export function evidenceOf(
  rel: RelationType,
  confidence: number,
  methodCall?: boolean
): EdgeEvidence {
  if (rel === "CALLS_API") {
    if (confidence >= 1) return "EXTRACTED";
    if (confidence >= 0.5) return "INFERRED";
    return "AMBIGUOUS";
  }
  if (rel === "PARAM_TYPE" || rel === "RETURN_TYPE" || rel === "TYPED_AS" || rel === "IMPLEMENTS") {
    return confidence >= 0.8 ? "EXTRACTED" : "INFERRED";
  }
  if (methodCall) return "AMBIGUOUS";
  if (rel === "QUERIES" || rel === "ROUTES_TO" || rel === "TESTS") return "INFERRED";
  if (rel === "USES" || rel === "REFERENCES") return "AMBIGUOUS";
  return confidence >= 1 ? "EXTRACTED" : "INFERRED";
}

// PRD FR-03: every relation carries weight + confidence.
// Static resolutions = 1.0; dynamic/star imports, unresolved calls < 1.0.
export const WEIGHT: Record<RelationType, number> = {
  CONTAINS: 1.0,
  IMPORTS: 0.9,
  EXPORTS: 0.9,
  TESTS: 0.9,
  ROUTES_TO: 0.9,
  IMPLEMENTS: 0.85,
  PARAM_TYPE: 0.85,
  RETURN_TYPE: 0.85,
  EXTENDS: 0.8,
  QUERIES: 0.8,
  CALLS_API: 0.8,
  TYPED_AS: 0.75,
  CALLS: 0.7,
  REFERENCES: 0.5,
  USES: 0.5,
};
