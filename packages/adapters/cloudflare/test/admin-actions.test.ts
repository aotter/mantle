import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { Manifest } from "@aotter/mantle-spec";
import { createCmsRef } from "../src/mount/bootRuntimeOnce.js";
import { mountServerEndpoints } from "../src/mount/mountServerEndpoints.js";
import { InMemoryDatabase } from "../../../mantle-runtime/test/fakes/database.js";
import {
  InMemoryKv,
  StubAssetServer,
  stubAuth,
} from "./fakes/runtime-bindings.js";
import type { Auth } from "../src/auth/createAuth.js";

function sessionAs(role: string | null, userId = "user-1") {
  return async () => ({
    session: { id: "s-1", userId, expiresAt: new Date(Date.now() + 60_000) },
    user: {
      id: userId,
      email: "tester@example.com",
      name: "Tester",
      role,
      githubLogin: "tester",
    },
  });
}

function harness(authOverride?: Partial<Auth>) {
  const auth: Auth = { ...stubAuth, ...authOverride };
  const ref = createCmsRef({
    manifests: ACTION_MANIFESTS,
    handlers: {
      echoAction: (input) => ({ echoed: input }),
    },
    bindings: {
      db: new InMemoryDatabase(),
      kv: new InMemoryKv(),
      assets: new StubAssetServer(),
    },
    auth,
  });
  const app = new Hono();
  mountServerEndpoints(app, ref);
  return { app };
}

function jsonInit(body: unknown): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

const ACTION_MANIFESTS: Manifest[] = [
  {
    apiVersion: "cms.mantle.aotter.net/v1",
    kind: "Procedure",
    metadata: { name: "echoAction" },
    spec: {
      requires: { auth: { all: [{ "ctx.staff": ["editor"] }] } },
      input: {
        type: "object",
        description: "Echo a payload.",
        properties: { message: { type: "string" } },
        required: ["message"],
      },
      output: {
        type: "object",
        properties: {
          echoed: {
            type: "object",
            properties: { message: { type: "string" } },
            required: ["message"],
          },
        },
        required: ["echoed"],
      },
      handler: { kind: "ref", ref: "echoAction" },
      admin: {
        operationKind: "system",
        audience: "agent",
        manualRun: "advanced",
      },
    },
  },
  {
    apiVersion: "cms.mantle.aotter.net/v1",
    kind: "Trigger",
    metadata: { name: "echoViaStaffMcp" },
    spec: {
      source: { kind: "mcp", surface: "staff" },
      target: { procedure: "echoAction" },
    },
  },
];

describe("admin actions endpoints", () => {
  it("requires a staff session", async () => {
    const { app } = harness();
    const anonymous = await app.request("/admin/api/actions");
    expect(anonymous.status).toBe(401);

    const forbidden = await harness({ getSession: sessionAs(null) }).app.request("/admin/api/actions");
    expect(forbidden.status).toBe(403);
  });

  it("lists Procedure manifests as declared admin actions", async () => {
    const { app } = harness({ getSession: sessionAs("editor") });
    const res = await app.request("/admin/api/actions");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Array<Record<string, unknown>> };
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({
      name: "echoAction",
      handlerKind: "ref",
      handlerRef: "echoAction",
      operationKind: "system",
      audience: "agent",
      manualRun: "advanced",
      description: "Echo a payload.",
    });
    expect(body.items[0]?.triggers).toEqual([
      {
        name: "echoViaStaffMcp",
        sourceKind: "mcp",
        surface: "staff",
      },
    ]);
  });

  it("returns NOT_FOUND for unknown action runs", async () => {
    const { app } = harness({ getSession: sessionAs("editor") });
    const res = await app.request("/admin/api/actions/missing/run", jsonInit({ input: {} }));
    expect(res.status).toBe(404);
    const body = (await res.json()) as { diagnostic: { code: string } };
    expect(body.diagnostic.code).toBe("NOT_FOUND");
  });

  it("runs actions through InvokeProcedureUseCase", async () => {
    const { app } = harness({ getSession: sessionAs("editor") });
    const res = await app.request(
      "/admin/api/actions/echoAction/run",
      jsonInit({ input: { message: "hello" } }),
    );
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      ok: true,
      data: { echoed: { message: "hello" } },
    });
  });
});
