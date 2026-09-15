import { describe, expect, it } from "vitest";
import {
  DiagnosticError, runtimeDiagnostic,
  linkManifestSet,
  parseManifestSources,
} from "@aotter/mantle-spec";
import {
  compileRuntimePlan,
  createMantleRequestHandler,
  createMantleRuntime,
  prepareDeployment,
} from "../src/index.js";
import { InMemoryEntryRepository } from "./fakes/in-memory-store.js";

const ctx = { user: { id: "u-1" }, staff: null, env: {} } as const;

describe("HTTP Trigger + builtin upsert OCC", () => {
  it("preserves host capacity rejection before builtin storage write", async () => {
    const { handle, store } = await boot(httpUpsertManifests());
    store.create = async () => { throw new DiagnosticError(runtimeDiagnostic({
      code: "RESOURCE_EXHAUSTED", severity: "error", path: "host/storage",
      message: "Storage capacity reached.",
      failure: { outcome: "not-applied", retry: "after-change", resource: "database" },
    }), { cause: new Error("private provider detail") }); };
    const response = await post(handle, "/api/posts", { title: "blocked" });
    expect(response.status).toBe(507);
    const body = await response.json();
    expect(body).toMatchObject({ diagnostic: { code: "RESOURCE_EXHAUSTED",
      failure: { outcome: "not-applied", retry: "after-change" } } });
    expect(JSON.stringify(body)).not.toContain("private provider detail");
  });

  it("create without version, update with observed version, stale 409; covers id and unique-key match", async () => {
    const { handle, store } = await boot(httpUpsertManifests());

    const created = await post(handle, "/api/settings", { siteKey: "main", theme: "dark" });
    expect(created.status).toBe(200);
    const createdBody = (await created.json()) as {
      ok: true;
      data: { id: string; version: number; data: { theme: string } };
    };
    expect(createdBody.data.version).toBe(1);

    const updated = await post(handle, "/api/settings", {
      siteKey: "main",
      theme: "light",
      expectedVersion: createdBody.data.version,
    });
    expect(updated.status).toBe(200);
    const updatedBody = (await updated.json()) as {
      ok: true;
      data: { id: string; version: number; data: { theme: string } };
    };
    expect(updatedBody.data.id).toBe(createdBody.data.id);
    expect(updatedBody.data.version).toBe(2);
    expect(updatedBody.data.data.theme).toBe("light");

    const stale = await post(handle, "/api/settings", {
      siteKey: "main",
      theme: "solarized",
      expectedVersion: createdBody.data.version,
    });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ diagnostic: { code: "CONFLICT" } });
    expect((await store.get(createdBody.data.id))?.data["theme"]).toBe("light");

    const missingVersion = await post(handle, "/api/settings", { siteKey: "main", theme: "other" });
    expect(missingVersion.status).toBe(400);
    expect(await missingVersion.json()).toMatchObject({ diagnostic: { code: "INPUT_VALIDATION_FAILED" } });

    const createdById = await post(handle, "/api/posts", { title: "first" });
    expect(createdById.status).toBe(200);
    const postRow = (await createdById.json()) as { data: { id: string; version: number } };
    const idUpdated = await post(handle, "/api/posts", {
      id: postRow.data.id,
      expectedVersion: postRow.data.version,
      title: "second",
    });
    expect(idUpdated.status).toBe(200);
    const staleId = await post(handle, "/api/posts", {
      id: postRow.data.id,
      expectedVersion: postRow.data.version,
      title: "third",
    });
    expect(staleId.status).toBe(409);

    const deletedTarget = await post(handle, "/api/posts", {
      id: "ghost",
      expectedVersion: 1,
      title: "nope",
    });
    expect(deletedTarget.status).toBe(404);
    expect(await deletedTarget.json()).toMatchObject({ diagnostic: { code: "NOT_FOUND" } });
  });

  it("membership match on [organizationId, userId] and does not recreate a deleted member", async () => {
    const { handle, store } = await boot(membershipManifests());
    const created = await post(handle, "/api/members", {
      organizationId: "org-1",
      userId: "user-a",
      role: "editor",
    });
    expect(created.status).toBe(200);
    const row = (await created.json()) as { data: { id: string; version: number } };

    const updated = await post(handle, "/api/members", {
      organizationId: "org-1",
      userId: "user-a",
      role: "owner",
      expectedVersion: row.data.version,
    });
    expect(updated.status).toBe(200);

    await store.delete({
      id: row.data.id,
      collection: "organization-members",
      expectedStatus: "published",
      expectedVersion: row.data.version + 1,
    });
    const recreate = await post(handle, "/api/members", {
      organizationId: "org-1",
      userId: "user-a",
      role: "contributor",
      expectedVersion: row.data.version + 1,
    });
    expect(recreate.status).toBe(404);
    expect((await store.list({ collection: "organization-members" })).rows).toHaveLength(0);
  });
});

async function boot(text: string) {
  const parsed = parseManifestSources({ sources: [{ sourceId: "memory:http-occ", text }] });
  if (!parsed.ok) throw new Error(parsed.diagnostics.map((d) => d.message).join("\n"));
  const linked = linkManifestSet(parsed.value);
  if (!linked.ok) throw new Error(linked.diagnostics.map((d) => d.message).join("\n"));
  const compiled = compileRuntimePlan(linked.value);
  if (!compiled.ok) throw new Error("expected compiled plan");
  const schemas = new Map(
    Object.values(compiled.value.schemas).map((s) => [s.manifest.metadata.name, s.manifest]),
  );
  const store = new InMemoryEntryRepository(schemas);
  const prepared = await prepareDeployment(compiled.value, {
    async prepare() {
      return {
        entries: store,
        views: {
          async execute() {
            return { rows: [], page: 1, show: 50, hasMore: false };
          },
        },
      };
    },
  });
  const runtime = createMantleRuntime({
    prepared,
    ports: { clock: { now: () => 1 }, idgen: (() => {
      let n = 0;
      return { next: () => `row-${++n}` };
    })() },
  });
  const handle = createMantleRequestHandler({
    plan: compiled.value,
    getRuntime: async () => runtime,
  });
  return { handle, store };
}

function post(
  handle: ReturnType<typeof createMantleRequestHandler>,
  path: string,
  body: Record<string, unknown>,
) {
  return handle(
    new Request(`https://site.test${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    ctx,
  ) as Promise<Response>;
}

function httpUpsertManifests(): string {
  return `apiVersion: cms.mantle.aotter.net/v1
kind: Schema
metadata: { name: site-settings }
spec:
  title: Site settings
  lifecycle: operational
  schema:
    type: object
    properties:
      siteKey: { type: string }
      theme: { type: string }
  uniqueIndexes:
    - [siteKey]
---
apiVersion: cms.mantle.aotter.net/v1
kind: Schema
metadata: { name: posts }
spec:
  title: Posts
  lifecycle: publishing
  schema:
    type: object
    properties:
      title: { type: string }
---
apiVersion: cms.mantle.aotter.net/v1
kind: Procedure
metadata: { name: upsert-setting }
spec:
  input:
    type: object
    required: [siteKey]
    properties:
      siteKey: { type: string }
      theme: { type: string }
      expectedVersion: { type: number }
  output: { type: object }
  handler:
    kind: builtin
    op: upsert
    schema: site-settings
    match: [siteKey]
---
apiVersion: cms.mantle.aotter.net/v1
kind: Procedure
metadata: { name: upsert-post }
spec:
  input:
    type: object
    properties:
      id: { type: string }
      expectedVersion: { type: number }
      title: { type: string }
  output: { type: object }
  handler: { kind: builtin, op: upsert, schema: posts }
---
apiVersion: cms.mantle.aotter.net/v1
kind: Trigger
metadata: { name: upsert-setting-http }
spec:
  source: { kind: http, method: POST, path: /api/settings }
  target: { procedure: upsert-setting }
---
apiVersion: cms.mantle.aotter.net/v1
kind: Trigger
metadata: { name: upsert-post-http }
spec:
  source: { kind: http, method: POST, path: /api/posts }
  target: { procedure: upsert-post }
`;
}

function membershipManifests(): string {
  return `apiVersion: cms.mantle.aotter.net/v1
kind: Schema
metadata: { name: organization-members }
spec:
  title: Organization members
  lifecycle: operational
  schema:
    type: object
    properties:
      organizationId: { type: string }
      userId: { type: string }
      role: { type: string }
  uniqueIndexes:
    - [organizationId, userId]
---
apiVersion: cms.mantle.aotter.net/v1
kind: Procedure
metadata: { name: upsert-member }
spec:
  input:
    type: object
    required: [organizationId, userId]
    properties:
      organizationId: { type: string }
      userId: { type: string }
      role: { type: string }
      expectedVersion: { type: number }
  output: { type: object }
  handler:
    kind: builtin
    op: upsert
    schema: organization-members
    match: [organizationId, userId]
---
apiVersion: cms.mantle.aotter.net/v1
kind: Trigger
metadata: { name: upsert-member-http }
spec:
  source: { kind: http, method: POST, path: /api/members }
  target: { procedure: upsert-member }
`;
}
