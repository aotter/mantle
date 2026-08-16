import { describe, expect, it } from "vitest";
import {
  linkManifestSet,
  parseManifestSources,
  type ParsedManifestSet,
} from "../src/index.js";

describe("linkManifestSet", () => {
  it("resolves graph references into one sealed value", () => {
    const linked = linkManifestSet(parse(`
apiVersion: cms.mantle.aotter.net/v1
kind: Schema
metadata: { name: products }
spec:
  title: Products
  schema:
    type: object
    properties: { slug: { type: string }, title: { type: string } }
---
apiVersion: cms.mantle.aotter.net/v1
kind: Schema
metadata: { name: product-translations }
spec:
  title: Product translations
  localized: true
  translates: { parent: products, on: slug }
  schema:
    type: object
    properties: { slug: { type: string }, locale: { type: string }, title: { type: string } }
---
apiVersion: cms.mantle.aotter.net/v1
kind: Procedure
metadata: { name: allow-product }
spec:
  input: { type: object }
  output: { type: object }
  handler: { kind: ref, ref: allowProduct }
---
apiVersion: cms.mantle.aotter.net/v1
kind: View
metadata: { name: product-list }
spec:
  surface: public
  from: products
  requires: { guard: { procedure: allow-product } }
---
apiVersion: cms.mantle.aotter.net/v1
kind: Procedure
metadata: { name: create-product }
spec:
  input: { type: object }
  uiSchema: { collectionAction: products }
  output: { type: object }
  handler: { kind: builtin, op: create, schema: products }
---
apiVersion: cms.mantle.aotter.net/v1
kind: Trigger
metadata: { name: product-created }
spec:
  source: { kind: lifecycle, schema: products, on: [after_create] }
  target: { procedure: create-product }
`));

    if (!linked.ok) throw new Error("expected valid linked graph");
    expect(linked.value.schemas[1]?.translationParent?.manifest.metadata.name).toBe("products");
    expect(linked.value.views[0]?.from?.manifest.metadata.name).toBe("products");
    expect(linked.value.views[0]?.guard?.manifest.metadata.name).toBe("allow-product");
    expect(linked.value.procedures[1]?.builtinSchema?.manifest.metadata.name).toBe("products");
    expect(linked.value.procedures[1]?.collectionActionSchema?.manifest.metadata.name)
      .toBe("products");
    expect(linked.value.triggers[0]?.target.manifest.metadata.name).toBe("create-product");
    expect(linked.value.triggers[0]?.lifecycleSchema?.manifest.metadata.name).toBe("products");
    expect(Object.isFrozen(linked.value)).toBe(true);
  });

  it("withholds a value and preserves every duplicate source span", () => {
    const source = (sourceId: string) => ({ sourceId, text: `apiVersion: cms.mantle.aotter.net/v1
kind: Schema
metadata: { name: posts }
spec:
  title: Posts
  schema: { type: object, properties: {} }
` });
    const parsed = parseManifestSources({
      sources: [source("memory:first"), source("memory:second")],
    });
    if (!parsed.ok) throw new Error("expected structurally valid duplicate fixture");

    const linked = linkManifestSet(parsed.value);

    expect(linked.ok).toBe(false);
    expect("value" in linked).toBe(false);
    expect(linked.diagnostics).toHaveLength(2);
    expect(linked.diagnostics.map((diagnostic) => diagnostic.source)).toEqual([
      expect.objectContaining({
        sourceId: "memory:first",
        documentIndex: 0,
        path: "/metadata/name",
        span: expect.any(Object),
      }),
      expect.objectContaining({
        sourceId: "memory:second",
        documentIndex: 0,
        path: "/metadata/name",
        span: expect.any(Object),
      }),
    ]);
  });

  it("rejects View names that collide after MCP name mangling", () => {
    const linked = linkManifestSet(parse(`
apiVersion: cms.mantle.aotter.net/v1
kind: Schema
metadata: { name: orders }
spec:
  title: Orders
  schema: { type: object, properties: {} }
---
apiVersion: cms.mantle.aotter.net/v1
kind: View
metadata: { name: open-orders }
spec: { surface: public, from: orders }
---
apiVersion: cms.mantle.aotter.net/v1
kind: View
metadata: { name: open_orders }
spec: { surface: public, from: orders }
`));

    expect(linked.ok).toBe(false);
    expect(linked.diagnostics).toContainEqual(expect.objectContaining({
      code: "MCP_TOOL_NAME_COLLISION",
      path: "/metadata/name",
      source: expect.objectContaining({ sourceId: "memory:link" }),
    }));
  });
});

function parse(text: string): ParsedManifestSet {
  const parsed = parseManifestSources({
    sources: [{ sourceId: "memory:link", text: text.trimStart() }],
  });
  if (!parsed.ok) {
    throw new Error(parsed.diagnostics.map((diagnostic) => diagnostic.message).join("\n"));
  }
  return parsed.value;
}
