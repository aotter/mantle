import { describe, expect, it } from "vitest";
import {
  parseManifestSources,
  sourceLocationAt,
} from "../src/domain/service/ManifestParser.js";

const schema = (name: string): string => `apiVersion: cms.mantle.aotter.net/v1
kind: Schema
metadata: { name: ${name} }
spec:
  title: ${name}
  schema: { type: object, properties: {} }
`;

describe("parseManifestSources", () => {
  it("keeps source-local document identity across empty documents and sources", () => {
    const result = parseManifestSources({
      sources: [
        { sourceId: "memory:first", text: `${schema("first")}---\n---\n${schema("third")}` },
        { sourceId: "memory:second", text: schema("second") },
      ],
    });

    if (!result.ok) throw new Error("expected valid sources");
    expect(result.value.entries.map(({ manifest, source }) => ({
      name: manifest.metadata.name,
      sourceId: source.sourceId,
      documentIndex: source.documentIndex,
      path: source.path,
      hasSpan: source.span !== undefined,
    }))).toEqual([
      { name: "first", sourceId: "memory:first", documentIndex: 0, path: "/", hasSpan: true },
      { name: "third", sourceId: "memory:first", documentIndex: 2, path: "/", hasSpan: true },
      { name: "second", sourceId: "memory:second", documentIndex: 0, path: "/", hasSpan: true },
    ]);
  });

  it("materializes schema and ordering defaults once", () => {
    const view = `apiVersion: cms.mantle.aotter.net/v1
kind: View
metadata: { name: newest }
spec:
  surface: public
  from: articles
  orderBy: [{ field: createdAt }]
`;
    const result = parseManifestSources({
      sources: [{ sourceId: "memory:defaults", text: `${schema("articles")}---\n${view}` }],
    });

    if (!result.ok) throw new Error("expected valid defaults fixture");
    expect(result.value.entries[0]?.manifest).toMatchObject({
      kind: "Schema",
      spec: {
        uniqueIndexes: [],
        indexes: [],
        searchableFields: [],
        localized: false,
        lifecycle: "publishing",
      },
    });
    expect(result.value.entries[1]?.manifest).toMatchObject({
      kind: "View",
      spec: { orderBy: [{ field: "createdAt", direction: "asc" }] },
    });
  });

  it("retains narrow authored spans for later semantic diagnostics", () => {
    const result = parseManifestSources({
      sources: [{ sourceId: "memory:span", text: schema("articles") }],
    });

    if (!result.ok) throw new Error("expected valid span fixture");
    expect(sourceLocationAt(result.value.entries[0]!, "/metadata/name")).toMatchObject({
      sourceId: "memory:span",
      documentIndex: 0,
      path: "/metadata/name",
      span: { start: { line: 3, column: 19 } },
    });
  });

  it("rejects duplicate source IDs before decoding", () => {
    const result = parseManifestSources({
      sources: [
        { sourceId: "memory:same", text: schema("first") },
        { sourceId: "memory:same", text: schema("second") },
      ],
    });

    expect(result.ok).toBe(false);
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]).toMatchObject({
      code: "INVALID_MANIFEST_ENVELOPE",
      path: "/sources/1/sourceId",
      source: { sourceId: "memory:same", documentIndex: 0 },
    });
  });
});
