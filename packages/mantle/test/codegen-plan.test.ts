import { linkManifestSet, parseManifestSources } from "@aotter/mantle-spec";
import { compileRuntimePlan } from "@aotter/mantle-runtime";
import { describe, expect, it } from "vitest";
import { emitMantleModule } from "../src/codegen.js";

describe("emitMantleModule", () => {
  it("emits the same typed module from a compiled plan", () => {
    const parsed = parseManifestSources({ sources: [{ sourceId: "memory:plan", text: `apiVersion: cms.mantle.aotter.net/v1
kind: Schema
metadata: { name: products }
spec:
  title: Products
  schema:
    type: object
    properties:
      sku: { type: string }
` }] });
    if (!parsed.ok) throw new Error("expected parsed fixture");
    const linked = linkManifestSet(parsed.value);
    if (!linked.ok) throw new Error("expected linked fixture");
    const compiled = compileRuntimePlan(linked.value);
    if (!compiled.ok) throw new Error("expected compiled fixture");

    const fromLinked = emitMantleModule({ linked: linked.value });
    const fromPlan = emitMantleModule({ plan: compiled.value });

    expect(fromPlan).toEqual(fromLinked);
    expect(fromPlan.ok && fromPlan.source).toContain(
      'readonly "products": Mantle.Entry_products;',
    );
  });

  it("keeps colliding lower-camel names distinct as wire keys", () => {
    const parsed = parseManifestSources({ sources: [{ sourceId: "memory:collision", text: [
      schema("open-orders"),
      schema("open.orders"),
    ].join("\n---\n") }] });
    if (!parsed.ok) throw new Error("expected parsed fixture");
    const linked = linkManifestSet(parsed.value);
    if (!linked.ok) throw new Error("expected linked fixture");
    const compiled = compileRuntimePlan(linked.value);
    if (!compiled.ok) throw new Error("expected compiled fixture");

    const emitted = emitMantleModule({ plan: compiled.value });
    expect(emitted.ok).toBe(true);
    if (!emitted.ok) return;
    expect(emitted.source).toContain('readonly "open-orders": Mantle.Entry_open_u002d_orders;');
    expect(emitted.source).toContain('readonly "open.orders": Mantle.Entry_open_u002e_orders;');
  });

  it("omits caller-filled scope and defaulted fields from typed insert requirements", () => {
    const parsed = parseManifestSources({ sources: [{ sourceId: "memory:scope", text: `apiVersion: cms.mantle.aotter.net/v1
kind: Schema
metadata: { name: scoped-posts }
spec:
  title: Scoped posts
  scope: { ownerId: "$ctx.user.id" }
  schema:
    type: object
    required: [ownerId, title, state]
    properties:
      ownerId: { type: string }
      title: { type: string }
      state: { type: string, default: draft }
  indexes: [[ownerId]]
` }] });
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.diagnostics));
    const linked = linkManifestSet(parsed.value);
    if (!linked.ok) throw new Error(JSON.stringify(linked.diagnostics));
    const emitted = emitMantleModule({ linked: linked.value });
    if (!emitted.ok) throw new Error(JSON.stringify(emitted.diagnostics));
    expect(emitted.source).toContain(
      'readonly "scoped-posts": Pick<Schemas["scoped-posts"], "ownerId" | "title"> & Partial<Pick<Schemas["scoped-posts"], "state">>;',
    );
    expect(emitted.source).toContain(
      'readonly "scoped-posts": Pick<Schemas["scoped-posts"], "title"> & Partial<Pick<Schemas["scoped-posts"], "ownerId" | "state">>;',
    );
  });
});

function schema(name: string): string {
  return `apiVersion: cms.mantle.aotter.net/v1
kind: Schema
metadata: { name: ${name} }
spec:
  title: Test
  schema: { type: object }
`;
}
