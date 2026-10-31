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
  moduleSpecifier?: string;
  importedSymbolName?: string;
}

export interface ParsedHeritage {
  ownerName: string;
  relationKind: "EXTENDS" | "IMPLEMENTS";
  targetName: string;
  moduleSpecifier?: string;
  importedName?: string;
}

export interface ParsedFile {
  symbols: ParsedSymbol[];
  imports: string[];
  calls: ParsedCall[];
  heritage: ParsedHeritage[];
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
  skippedFiles: string[];
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
