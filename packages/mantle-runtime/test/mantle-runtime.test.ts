import {
  linkManifestSet,
  parseManifestSources,
  type LinkedManifestSet,
} from "@aotter/mantle-spec";
import { describe, expect, it } from "vitest";
import { createMantleRuntime } from "../src/index.js";
import {
  compileRuntimePlan,
  type RuntimePlan,
} from "../src/domain/service/RuntimePlanCompiler.js";
import { InMemoryEntryRepository } from "./fakes/in-memory-store.js";

const anonymous = { user: null, staff: null, env: {} } as const;

describe("createMantleRuntime", () => {
  it("binds headless content, View, Procedure, and Trigger operations by name", async () => {
    const entries = new InMemoryEntryRepository();
    const seenViewUsers: Array<string | undefined> = [];
    const lifecycleEvents: string[] = [];
    const runtime = createMantleRuntime({
      plan: compilePlan(manifests),
      prepared: {
        entries,
        views: {
          async execute(request) {
            seenViewUsers.push(request.ctxUserId);
            return {
              rows: [{ userId: request.ctxUserId }],
              page: request.page ?? 1,
              show: request.show ?? 50,
              hasMore: false,
            };
          },
        },
      },
      handlers: {
        echo: (_input, ctx) => ({ userId: ctx.user?.id }),
        audit: (_input, ctx) => {
          lifecycleEvents.push(`${ctx.event?.hook}:${ctx.event?.entry?.id}`);
          return {};
        },
      },
      ports: {
        clock: { now: () => 10 },
        idgen: { next: () => "post-1" },
      },
    });

    expect(runtime).not.toHaveProperty("plan");
    expect(runtime).not.toHaveProperty("schemasByName");
    expect(runtime).not.toHaveProperty("bootInit");
    expect(runtime.schemas.get("posts")?.metadata.name).toBe("posts");
    await runtime.createDraft.execute({
      collection: "posts",
      data: { title: "Embedded" },
      authorId: null,
    });
    expect(await runtime.entries.readById("post-1"))
      .toMatchObject({ id: "post-1", data: { title: "Embedded" } });
    expect(lifecycleEvents).toEqual(["after_create:post-1"]);

    expect(await runtime.invokeProcedure({
      procedure: "secure-echo",
      input: {},
      ctx: anonymous,
    })).toMatchObject({ ok: false, diagnostic: { code: "UNAUTHENTICATED" } });
    expect(await runtime.executeView({ view: "secure-posts", ctx: anonymous }))
      .toMatchObject({ ok: false, diagnostic: { code: "UNAUTHENTICATED" } });
    expect(await runtime.invokeTrigger({
      trigger: "secure-http",
      input: {},
      ctx: anonymous,
    })).toMatchObject({ ok: false, diagnostic: { code: "UNAUTHENTICATED" } });
    expect(seenViewUsers).toEqual([]);

    const userA = { user: { id: "user-a" }, staff: null, env: { request: "a" } } as const;
    const userB = { user: { id: "user-b" }, staff: null, env: { request: "b" } } as const;
    expect(await runtime.invokeProcedure({
      procedure: "secure-echo",
      input: {},
      ctx: userA,
    })).toEqual({ ok: true, data: { userId: "user-a" } });
    expect(await runtime.invokeTrigger({
      trigger: "secure-http",
      input: {},
      ctx: userB,
    })).toEqual({ ok: true, data: { userId: "user-b" } });
    expect(await runtime.executeView({ view: "secure-posts", ctx: userA }))
      .toMatchObject({ ok: true, result: { rows: [{ userId: "user-a" }] } });
    expect(seenViewUsers).toEqual(["user-a"]);
    expect(await runtime.executeView({ view: "missing", ctx: userA }))
      .toMatchObject({ ok: false, diagnostic: { code: "NOT_FOUND" } });
  });
});

function compilePlan(text: string): RuntimePlan {
  const linked = parseAndLink(text);
  const compiled = compileRuntimePlan(linked);
  if (!compiled.ok) throw new Error("expected compiled runtime fixture");
  return compiled.value;
}

function parseAndLink(text: string): LinkedManifestSet {
  const parsed = parseManifestSources({
    sources: [{ sourceId: "memory:runtime", text }],
  });
  if (!parsed.ok) throw new Error(parsed.diagnostics.map((item) => item.message).join("\n"));
  const linked = linkManifestSet(parsed.value);
  if (!linked.ok) throw new Error(linked.diagnostics.map((item) => item.message).join("\n"));
  return linked.value;
}

const manifests = `apiVersion: cms.mantle.aotter.net/v1
kind: Schema
metadata: { name: posts }
spec:
  title: Posts
  lifecycle: operational
  schema:
    type: object
    required: [title]
    properties:
      title: { type: string }
---
apiVersion: cms.mantle.aotter.net/v1
kind: Procedure
metadata: { name: secure-echo }
spec:
  input: { type: object }
  output:
    type: object
    required: [userId]
    properties:
      userId: { type: string }
  handler: { kind: ref, ref: echo }
  requires:
    auth: { all: [ctx.user] }
---
apiVersion: cms.mantle.aotter.net/v1
kind: Procedure
metadata: { name: audit-create }
spec:
  input: { type: object }
  output: { type: object }
  handler: { kind: ref, ref: audit }
---
apiVersion: cms.mantle.aotter.net/v1
kind: View
metadata: { name: secure-posts }
spec:
  surface: public
  from: posts
  fields: [id, title]
  requires:
    auth: { all: [ctx.user] }
---
apiVersion: cms.mantle.aotter.net/v1
kind: Trigger
metadata: { name: secure-http }
spec:
  source: { kind: http, method: POST, path: /api/secure }
  target: { procedure: secure-echo }
---
apiVersion: cms.mantle.aotter.net/v1
kind: Trigger
metadata: { name: audit-created-post }
spec:
  source: { kind: lifecycle, schema: posts, on: [after_create] }
  target: { procedure: audit-create }
`;
