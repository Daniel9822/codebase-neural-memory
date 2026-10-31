export type SymbolKind =
  | "function"
  | "class"
  | "method"
  | "interface"
  | "type"
  | "enum";

export interface ParsedSymbol {
  name: string;
  kind: SymbolKind;
  signature: string;
  startLine: number;
  endLine: number;
  exported: boolean;
}

export interface ParsedCall {
  callerName: string | null;
  calleeName: string;
}

export interface ParsedFile {
  symbols: ParsedSymbol[];
  imports: string[];
  calls: ParsedCall[];
}

export interface IndexSummary {
  scanned: number;
  added: number;
  updated: number;
  unchanged: number;
  deleted: number;
  symbols: number;
  relations: number;
  skipped: number;
  failed: number;
  errors: string[];
}

export interface SearchHit {
  name: string;
  kind: string;
  signature: string;
  filePath: string;
  startLine: number;
  endLine: number;
  exported: boolean;
}
