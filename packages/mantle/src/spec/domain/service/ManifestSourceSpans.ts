/** Authored YAML spans: where a parsed semantic path came from, for diagnostics. */
import { LineCounter, isMap, isNode, isScalar, isSeq, type Document, type Node } from "yaml";
import type { SourceLocation, SourceSpan } from "../../kernel/diagnostic.js";
import type { ParsedManifestEntry } from "./ManifestParser.js";

/** Resolve the narrowest retained authored span for a parsed semantic path. */
export function sourceLocationAt(
  entry: ParsedManifestEntry,
  path: string,
): SourceLocation {
  let candidate = path;
  let span = entry.sourceSpans[candidate];
  while (!span && candidate !== "/") {
    const slash = candidate.lastIndexOf("/");
    candidate = slash <= 0 ? "/" : candidate.slice(0, slash);
    span = entry.sourceSpans[candidate];
  }
  return {
    sourceId: entry.source.sourceId,
    documentIndex: entry.source.documentIndex,
    path,
    ...(span ? { span } : {}),
  };
}

export function collectSourceSpans(
  root: Node | null,
  lineCounter: LineCounter,
): Readonly<Record<string, SourceSpan>> {
  const spans: Record<string, SourceSpan> = {};
  const visit = (node: Node | null, path: string): void => {
    if (!node) return;
    const span = sourceSpan(lineCounter, node.range);
    if (span) spans[path] = span;
    if (isMap(node)) {
      for (const pair of node.items) {
        if (!isScalar(pair.key)) continue;
        const key = String(pair.key.value).replace(/~/g, "~0").replace(/\//g, "~1");
        visit(isNode(pair.value) ? pair.value : null, path === "/" ? `/${key}` : `${path}/${key}`);
      }
    } else if (isSeq(node)) {
      node.items.forEach((item, index) =>
        visit(isNode(item) ? item : null, path === "/" ? `/${index}` : `${path}/${index}`)
      );
    }
  };
  visit(root, "/");
  return Object.freeze(spans);
}

export function sourceLocationForNode(
  sourceId: string,
  documentIndex: number,
  path: string,
  doc: Document.Parsed,
  lineCounter: LineCounter,
): SourceLocation {
  const parts = path === "/"
    ? []
    : path.slice(1).split("/").map((part) => {
        const decoded = part.replace(/~1/g, "/").replace(/~0/g, "~");
        return /^\d+$/.test(decoded) ? Number(decoded) : decoded;
      });
  let range: readonly number[] | null | undefined;
  for (let length = parts.length; length >= 0 && !range; length--) {
    const node = length === 0 ? doc.contents : doc.getIn(parts.slice(0, length), true);
    if (node && typeof node === "object" && "range" in node) {
      range = (node as { readonly range?: readonly number[] | null }).range;
    }
  }
  return sourceLocation(sourceId, documentIndex, path, lineCounter, range ?? doc.range);
}

export function sourceLocation(
  sourceId: string,
  documentIndex: number,
  path: string,
  lineCounter: LineCounter,
  range?: readonly number[] | null,
): SourceLocation {
  const span = sourceSpan(lineCounter, range);
  return { sourceId, documentIndex, path, ...(span ? { span } : {}) };
}

function sourceSpan(
  lineCounter: LineCounter,
  range?: readonly number[] | null,
): SourceSpan | undefined {
  if (!range || range.length < 2) return undefined;
  const startOffset = range[0];
  const endOffset = range.length > 2 ? range[2] : range[1];
  if (startOffset === undefined || endOffset === undefined) return undefined;
  const start = lineCounter.linePos(startOffset);
  const end = lineCounter.linePos(endOffset);
  return {
    start: { line: start.line, column: start.col, offset: startOffset },
    end: { line: end.line, column: end.col, offset: endOffset },
  };
}
