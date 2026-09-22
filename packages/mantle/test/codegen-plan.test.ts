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
      'findManyByDataField: <F extends ("sku") & keyof Mantle.Entry_products>',
    );
  });

  it("reports generated identifier collisions from a plan", () => {
    const parsed = parseManifestSources({ sources: [{ sourceId: "memory:collision", text: [
      schema("open-orders"),
      schema("open.orders"),
    ].join("\n---\n") }] });
    if (!parsed.ok) throw new Error("expected parsed fixture");
    const linked = linkManifestSet(parsed.value);
    if (!linked.ok) throw new Error("expected linked fixture");
    const compiled = compileRuntimePlan(linked.value);
    if (!compiled.ok) throw new Error("expected compiled fixture");

    expect(emitMantleModule({ plan: compiled.value })).toEqual({
      ok: false,
      diagnostics: [expect.objectContaining({
        code: "CODEGEN_IDENTIFIER_COLLISION",
        source: expect.objectContaining({ sourceId: "runtime-plan" }),
      })],
    });
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
