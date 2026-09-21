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

  it("warns when an MCP-exposed Procedure has no description, without withholding the link", () => {
    const linked = linkManifestSet(parse(`
apiVersion: cms.mantle.aotter.net/v1
kind: Procedure
metadata: { name: suspend-tenant }
spec:
  input: { type: object }
  output: { type: object }
  handler: { kind: ref, ref: suspend-tenant }
---
apiVersion: cms.mantle.aotter.net/v1
kind: Procedure
metadata: { name: measure-usage }
spec:
  description: { en: "Measure D1/R2 usage for one tenant.", zh-TW: "量測單一租戶用量。" }
  input: { type: object }
  output: { type: object }
  handler: { kind: ref, ref: measure-usage }
---
apiVersion: cms.mantle.aotter.net/v1
kind: Procedure
metadata: { name: http-only }
spec:
  input: { type: object }
  output: { type: object }
  handler: { kind: ref, ref: http-only }
---
apiVersion: cms.mantle.aotter.net/v1
kind: Trigger
metadata: { name: suspend-tenant-staff }
spec:
  source: { kind: mcp, surface: staff }
  target: { procedure: suspend-tenant }
---
apiVersion: cms.mantle.aotter.net/v1
kind: Trigger
metadata: { name: suspend-tenant-public }
spec:
  source: { kind: mcp, surface: public }
  target: { procedure: suspend-tenant }
---
apiVersion: cms.mantle.aotter.net/v1
kind: Trigger
metadata: { name: measure-usage-staff }
spec:
  source: { kind: mcp, surface: staff }
  target: { procedure: measure-usage }
---
apiVersion: cms.mantle.aotter.net/v1
kind: Trigger
metadata: { name: http-only-http }
spec:
  source: { kind: http, method: POST, path: /api/http-only }
  target: { procedure: http-only }
`));

    expect(linked.ok).toBe(true);
    const warnings = linked.diagnostics.filter((d) => d.code === "MCP_TOOL_DESCRIPTION_MISSING");
    expect(warnings).toEqual([expect.objectContaining({
      severity: "warning",
      path: "/spec/description",
      message: expect.stringContaining("'suspend-tenant'"),
    })]);
    expect(warnings[0]?.message).toContain("staff surface");
    expect(warnings[0]?.message).toContain("'suspend-tenant-staff'");
  });

  it("warns when an MCP write tool's expectedVersion cannot be read from any View on its surface", () => {
    const linked = linkManifestSet(parse(`
apiVersion: cms.mantle.aotter.net/v1
kind: Schema
metadata: { name: tenants }
spec:
  title: Tenants
  lifecycle: operational
  schema: { type: object, readOnly: true, properties: { slug: { type: string }, enabled: { type: boolean } } }
---
apiVersion: cms.mantle.aotter.net/v1
kind: Schema
metadata: { name: organizations }
spec:
  title: Organizations
  lifecycle: operational
  schema: { type: object, readOnly: true, properties: { name: { type: string }, projectLimit: { type: number } } }
---
apiVersion: cms.mantle.aotter.net/v1
kind: Procedure
metadata: { name: suspend-tenant }
spec:
  description: Suspend one tenant.
  input:
    type: object
    required: [tenantId, expectedVersion]
    properties:
      tenantId: { type: string, x-mantle-ref: tenants }
      expectedVersion: { type: number }
  output: { type: object }
  handler: { kind: ref, ref: suspend-tenant }
---
apiVersion: cms.mantle.aotter.net/v1
kind: Procedure
metadata: { name: set-organization-quotas }
spec:
  description: Set quotas.
  input:
    type: object
    required: [id, expectedVersion, projectLimit]
    properties:
      id: { type: string, x-mantle-ref: organizations }
      expectedVersion: { type: number }
      projectLimit: { type: number }
  output: { type: object }
  handler: { kind: builtin, op: update, schema: organizations }
---
apiVersion: cms.mantle.aotter.net/v1
kind: View
metadata: { name: platform-tenant-status }
spec:
  surface: staff
  sql: "SELECT t._mantle_id AS tenantId, t.slug FROM tenants t"
---
apiVersion: cms.mantle.aotter.net/v1
kind: View
metadata: { name: platform-organizations }
spec:
  surface: staff
  from: organizations
---
apiVersion: cms.mantle.aotter.net/v1
kind: View
metadata: { name: member-tenant }
spec:
  surface: public
  from: tenants
  fields: [id, slug, version]
---
apiVersion: cms.mantle.aotter.net/v1
kind: Trigger
metadata: { name: suspend-tenant-staff }
spec:
  source: { kind: mcp, surface: staff }
  target: { procedure: suspend-tenant }
---
apiVersion: cms.mantle.aotter.net/v1
kind: Trigger
metadata: { name: set-organization-quotas-staff }
spec:
  source: { kind: mcp, surface: staff }
  target: { procedure: set-organization-quotas }
`));

    expect(linked.ok).toBe(true);
    const warnings = linked.diagnostics.filter((d) => d.code === "MCP_TOOL_INPUT_UNREACHABLE");
    // The staff SQL View over tenants selects no version column, so suspend-tenant
    // is unreachable there even though the public member-tenant View exposes it.
    // platform-organizations omits `fields`, so the default projection carries
    // version and set-organization-quotas is reachable.
    expect(warnings.map((d) => [d.severity, d.value, d.path])).toEqual([
      ["warning", "tenants", "/spec/input/properties/expectedVersion"],
    ]);
    expect(warnings[0]?.message).toContain("suspend_tenant");
    expect(warnings[0]?.message).toContain("staff");
  });

  it("allows manifests to define the removed generic read tool names", () => {
    const linked = linkManifestSet(parse(`
apiVersion: cms.mantle.aotter.net/v1
kind: Procedure
metadata: { name: get-entry }
spec:
  input: { type: object }
  output: { type: object }
  handler: { kind: ref, ref: get-entry }
---
apiVersion: cms.mantle.aotter.net/v1
kind: Trigger
metadata: { name: get-entry-mcp }
spec:
  source: { kind: mcp, surface: staff }
  target: { procedure: get-entry }
`));

    expect(linked.ok).toBe(true);
  });

  it("rejects duplicate MCP bindings that would lose Trigger identity", () => {
    const linked = linkManifestSet(parse(`
apiVersion: cms.mantle.aotter.net/v1
kind: Procedure
metadata: { name: lookup }
spec:
  input: { type: object }
  output: { type: object }
  handler: { kind: ref, ref: lookup }
---
apiVersion: cms.mantle.aotter.net/v1
kind: Trigger
metadata: { name: lookup-first }
spec:
  source: { kind: mcp, surface: public }
  target: { procedure: lookup }
---
apiVersion: cms.mantle.aotter.net/v1
kind: Trigger
metadata: { name: lookup-second }
spec:
  source: { kind: mcp, surface: public }
  target: { procedure: lookup }
`));

    expect(linked.ok).toBe(false);
    expect(linked.diagnostics).toContainEqual(expect.objectContaining({
      code: "MCP_TOOL_NAME_COLLISION",
      path: "/spec/source",
      value: "lookup",
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
