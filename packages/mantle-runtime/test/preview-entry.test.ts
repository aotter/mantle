import { linkManifestSet, parseManifestSources } from "@aotter/mantle-spec";
import { describe, expect, it, vi } from "vitest";
import { bindCapabilities, type CapabilityRuntime } from "../src/bindCapabilities.js";
import type { HandlerContext } from "../src/domain/model/HandlerContext.js";
import { compileRuntimePlan, type RuntimePlan } from "../src/domain/service/RuntimePlanCompiler.js";

/** ADR-0029 D10: a staff-only, read-only site preview bound to rendered collections. */

const plan = compile(`apiVersion: cms.mantle.aotter.net/v1
kind: Schema
metadata: { name: posts }
spec:
  title: Posts
  schema: { type: object, properties: { title: { type: string } } }
`);

describe("preview_entry", () => {
  it("renders through the preview port for staff, bounded to rendered collections", async () => {
    const execute = vi.fn(async ({ id }: { id: string }) => (id === "p1" ? "<html>p1</html>" : null));
    const staff = bindCapabilities(runtime(), plan, { surface: "staff", preview: { collections: ["posts", "ghosts"], execute } });
    expect(staff.catalog.get("preview_entry")).toMatchObject({
      hints: { readOnly: true },
      minimumRole: "contributor",
      inputSchema: { properties: { collection: { enum: ["posts"] } } },
    });
    expect(await staff.execute({ name: "preview_entry", args: { collection: "posts", id: "p1" }, ctx: editor() }))
      .toEqual({ ok: true, data: { html: "<html>p1</html>" } });
    expect(await staff.execute({ name: "preview_entry", args: { collection: "posts", id: "gone" }, ctx: editor() }))
      .toMatchObject({ ok: false, diagnostic: { code: "NOT_FOUND" } });
    expect(await staff.execute({ name: "preview_entry", args: { collection: "users", id: "u1" }, ctx: editor() }))
      .toMatchObject({ ok: false, diagnostic: { code: "INPUT_VALIDATION_FAILED" } });
    expect(await staff.execute({ name: "preview_entry", args: { collection: "posts", id: "p1" }, ctx: { ...editor(), staff: null } }))
      .toMatchObject({ ok: false });
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("never exists on the public surface or without a renderer", () => {
    const preview = { collections: ["posts"], execute: async () => "<html></html>" };
    expect(bindCapabilities(runtime(), plan, { surface: "public", preview }).catalog.get("preview_entry")).toBeUndefined();
    expect(bindCapabilities(runtime(), plan, { surface: "staff" }).catalog.get("preview_entry")).toBeUndefined();
  });
});

function runtime(): CapabilityRuntime {
  const unused = { execute: vi.fn() };
  return {
    schemas: new Map(Object.values(plan.schemas).map(({ manifest }) => [manifest.metadata.name, manifest])),
    getEntry: unused, createDraft: unused, updateDraft: unused, requestPublish: unused,
    unpublish: unused, archive: unused, deleteEntry: unused,
    executeView: vi.fn(), invokeTrigger: vi.fn(), media: null,
  } as unknown as CapabilityRuntime;
}

function editor(): HandlerContext {
  return { user: { id: "s1" }, staff: { id: "s1", role: "editor" }, env: {} } as HandlerContext;
}

function compile(text: string): RuntimePlan {
  const parsed = parseManifestSources({ sources: [{ sourceId: "memory:preview", text }] });
  if (!parsed.ok) throw new Error(parsed.diagnostics.map((item) => item.message).join("\n"));
  const linked = linkManifestSet(parsed.value);
  if (!linked.ok) throw new Error(linked.diagnostics.map((item) => item.message).join("\n"));
  const compiled = compileRuntimePlan(linked.value);
  if (!compiled.ok) throw new Error("expected compiled plan");
  return compiled.value;
}
