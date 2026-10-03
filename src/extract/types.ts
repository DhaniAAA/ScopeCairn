// PRD FR-02 / FR-03 types. Fase 2: deterministic regex extractor.
// Tree-sitter WASM grammars plug in here later without changing the shape.

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
  | "QUERIES";

export interface ExtractedSymbol {
  name: string;
  type: SymbolType;
  signature: string;
  startLine: number;
  endLine: number;
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
}

export interface FileExtraction {
  symbols: ExtractedSymbol[];
  relations: RawRelation[];
}

// PRD FR-03: every relation carries weight + confidence.
// Static resolutions = 1.0; dynamic/star imports, unresolved calls < 1.0.
export const WEIGHT: Record<RelationType, number> = {
  CONTAINS: 1.0,
  IMPORTS: 0.9,
  EXPORTS: 0.9,
  TESTS: 0.9,
  ROUTES_TO: 0.9,
  EXTENDS: 0.8,
  IMPLEMENTS: 0.8,
  QUERIES: 0.8,
  CALLS: 0.7,
  REFERENCES: 0.5,
  USES: 0.5,
};
