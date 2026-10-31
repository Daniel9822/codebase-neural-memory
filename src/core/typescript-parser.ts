import ts from "typescript";
import type { ParsedCall, ParsedFile, ParsedSymbol, SymbolKind } from "../shared/types.js";

const supportedExtensions = new Set([".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"]);

export function isSupportedSourceFile(path: string): boolean {
  const extension = path.slice(path.lastIndexOf(".")).toLowerCase();
  return supportedExtensions.has(extension);
}

function getModifiers(node: ts.Node): readonly ts.Modifier[] | undefined {
  return ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
}

function hasExportModifier(node: ts.Node): boolean {
  return Boolean(getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword));
}

function nodeName(node: ts.NamedDeclaration): string | undefined {
  if (!node.name) return undefined;
  if (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)) return node.name.text;
  return node.name.getText();
}

export function parseTypeScriptFile(filePath: string, source: string): ParsedFile {
  const scriptKind = filePath.endsWith(".tsx") || filePath.endsWith(".jsx")
    ? ts.ScriptKind.TSX
    : filePath.endsWith(".js") || filePath.endsWith(".mjs") || filePath.endsWith(".cjs")
      ? ts.ScriptKind.JS
      : ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true, scriptKind);
  const parseDiagnostics = (sourceFile as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] }).parseDiagnostics;
  if (parseDiagnostics.length > 0) {
    const details = parseDiagnostics.map((diagnostic) => {
      const position = diagnostic.start ?? 0;
      const location = sourceFile.getLineAndCharacterOfPosition(position);
      const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, " ");
      return filePath + ":" + (location.line + 1) + ":" + (location.character + 1) + " " + message;
    });
    throw new SyntaxError("Unable to parse source file: " + details.join("; "));
  }
  const symbols: ParsedSymbol[] = [];
  const imports = new Set<string>();
  const calls: ParsedCall[] = [];

  const addSymbol = (node: ts.Node, name: string, kind: SymbolKind, exported: boolean, owner?: string) => {
    const start = node.getStart(sourceFile);
    const end = node.getEnd();
    const startLine = sourceFile.getLineAndCharacterOfPosition(start).line + 1;
    const endLine = sourceFile.getLineAndCharacterOfPosition(end).line + 1;
    const firstLine = source.slice(start, end).split(/\r?\n/, 1)[0]?.trim() ?? name;
    const qualifiedName = owner ? `${owner}.${name}` : name;
    symbols.push({
      name: qualifiedName,
      kind,
      signature: firstLine.slice(0, 300),
      startLine,
      endLine,
      exported,
    });
  };

  const visit = (node: ts.Node, owner: string | null = null): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      imports.add(node.moduleSpecifier.text);
    }
    if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      imports.add(node.moduleSpecifier.text);
    }

    let nextOwner = owner;
    if (ts.isFunctionDeclaration(node)) {
      const name = nodeName(node);
      if (name) {
        addSymbol(node, name, "function", hasExportModifier(node));
        nextOwner = name;
      }
    } else if (ts.isClassDeclaration(node)) {
      const name = nodeName(node);
      if (name) {
        addSymbol(node, name, "class", hasExportModifier(node));
        nextOwner = name;
      }
    } else if (ts.isInterfaceDeclaration(node)) {
      const name = nodeName(node);
      if (name) addSymbol(node, name, "interface", hasExportModifier(node));
    } else if (ts.isTypeAliasDeclaration(node)) {
      addSymbol(node, node.name.text, "type", hasExportModifier(node));
    } else if (ts.isEnumDeclaration(node)) {
      addSymbol(node, node.name.text, "enum", hasExportModifier(node));
    } else if (ts.isMethodDeclaration(node) && nodeName(node)) {
      const methodName = nodeName(node)!;
      addSymbol(node, methodName, "method", false, owner ?? undefined);
      nextOwner = owner ? `${owner}.${methodName}` : methodName;
    } else if (ts.isVariableDeclaration(node) && node.initializer &&
      (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) {
      const name = nodeName(node);
      if (name) {
        const variableStatement = node.parent.parent;
        const exported = ts.isVariableStatement(variableStatement) && hasExportModifier(variableStatement);
        addSymbol(node, name, "function", exported);
        nextOwner = name;
      }
    }

    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      calls.push({ callerName: nextOwner, calleeName: node.expression.text });
    }
    node.forEachChild((child) => visit(child, nextOwner));
  };

  visit(sourceFile);
  return { symbols, imports: [...imports], calls };
}
