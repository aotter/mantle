import { linkManifestSet, parseManifestSources } from "@aotter/mantle-spec";
import { describe, expect, it, vi } from "vitest";
import { bindCapabilities, type CapabilityRuntime } from "../src/bindCapabilities.js";
import { compileRuntimePlan, type RuntimePlan } from "../src/domain/service/RuntimePlanCompiler.js";
import type { HandlerContext } from "../src/domain/model/HandlerContext.js";

const manifest = `apiVersion: cms.mantle.aotter.net/v1
kind: Schema
metadata: { name: posts }
spec:
  title: Posts
  schema:
    type: object
    properties:
      title: { type: string }
---
apiVersion: cms.mantle.aotter.net/v1
kind: View
metadata: { name: staff-posts }
spec:
  surface: staff
  from: posts
---
apiVersion: cms.mantle.aotter.net/v1
kind: View
metadata: { name: public-posts }
spec:
  surface: public
  from: posts
---
apiVersion: cms.mantle.aotter.net/v1
kind: Procedure
metadata: { name: ping }
spec:
  input: { type: object }
  output: { type: object }
  handler: { kind: ref, ref: ping }
---
apiVersion: cms.mantle.aotter.net/v1
kind: Trigger
metadata: { name: ping-staff }
spec:
  source: { kind: mcp, surface: staff }
  target: { procedure: ping }
---
apiVersion: cms.mantle.aotter.net/v1
kind: Procedure
metadata: { name: http-only }
spec:
  requires:
    auth:
      all:
        - { "ctx.staff": [owner] }
  input: { type: object }
  output: { type: object }
  handler: { kind: ref, ref: http-only }
---
apiVersion: cms.mantle.aotter.net/v1
kind: Trigger
metadata: { name: http-only-http }
spec:
  source: { kind: http, method: POST, path: /api/http-only }
  target: { procedure: http-only }
`;

const purposes = [{ name: "post-cover", required: ["image/jpeg"], maxBytes: { "image/jpeg": 1 } }];

describe("bindCapabilities", () => {
  it("binds each surface's catalog from the sealed plan", () => {
    const plan = compile(manifest);
    const runtime = fakeRuntime(plan);
    expect(names(bindCapabilities(runtime, plan, { surface: "public" }))).toEqual(["query_view_public_posts"]);
    const staff = names(bindCapabilities(runtime, plan, { surface: "staff" }));
    expect(staff).toEqual(expect.arrayContaining(["query_view_staff_posts", "ping", "create_draft_posts", "request_publish"]));
    expect(staff).not.toContain("query_view_public_posts");
  });

  it("never exposes an HTTP-only staff Procedure", () => {
    const plan = compile(manifest);
    const staff = names(bindCapabilities(fakeRuntime(plan), plan, { surface: "staff" }));
    expect(staff).toContain("ping");
    expect(staff).not.toContain("http_only");
  });

  it("serves media operations only with media storage and declared purposes", () => {
    const plan = compile(manifest);
    const media = { createUpload: { execute: vi.fn() }, commitUpload: { execute: vi.fn() } };
    expect(names(bindCapabilities(fakeRuntime(plan, media), plan, { surface: "staff" })))
      .not.toContain("create_media_upload");
    expect(names(bindCapabilities(fakeRuntime(plan, media), plan, { surface: "staff", mediaPurposes: purposes })))
      .toEqual(expect.arrayContaining(["create_media_upload", "commit_media_upload"]));
    expect(names(bindCapabilities(fakeRuntime(plan, null), plan, { surface: "staff", mediaPurposes: purposes })))
      .not.toContain("create_media_upload");
  });

  it("routes View calls to the runtime by View name", async () => {
    const plan = compile(manifest);
    const runtime = fakeRuntime(plan);
    const invoker = bindCapabilities(runtime, plan, { surface: "public" });
    expect(await invoker.execute({ name: "query_view_public_posts", args: {}, ctx: context() }))
      .toMatchObject({ ok: true, data: { rows: [] } });
    expect(runtime.executeView).toHaveBeenCalledWith(expect.objectContaining({ view: "public-posts" }));
  });
});

function names(invoker: ReturnType<typeof bindCapabilities>): string[] {
  return invoker.catalog.capabilities.map((capability) => capability.name);
}

function compile(text: string): RuntimePlan {
  const parsed = parseManifestSources({ sources: [{ sourceId: "memory:mcp", text }] });
  if (!parsed.ok) throw new Error(parsed.diagnostics.map((item) => item.message).join("\n"));
  const linked = linkManifestSet(parsed.value);
  if (!linked.ok) throw new Error(linked.diagnostics.map((item) => item.message).join("\n"));
  const compiled = compileRuntimePlan(linked.value);
  if (!compiled.ok) throw new Error("expected compiled plan");
  return compiled.value;
}

function fakeRuntime(
  plan: RuntimePlan,
  media: { createUpload: unknown; commitUpload: unknown } | null = null,
) {
  const unused = { execute: vi.fn() };
  return {
    schemas: new Map(Object.values(plan.schemas).map(({ manifest }) => [manifest.metadata.name, manifest])),
    getEntry: unused,
    createDraft: unused,
    updateDraft: unused,
    requestPublish: unused,
    unpublish: unused,
    archive: unused,
    deleteEntry: unused,
    executeView: vi.fn(async () => ({ ok: true as const, result: { rows: [], page: 1, show: 20, hasMore: false } })),
    invokeTrigger: vi.fn(async () => ({ ok: true as const, data: {} })),
    media,
  } as unknown as CapabilityRuntime & { executeView: ReturnType<typeof vi.fn> };
}

function context(): HandlerContext {
  return { user: null, staff: null, env: {} };
}
