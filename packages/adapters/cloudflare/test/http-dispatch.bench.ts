import { compileTestPlan } from "./compileTestPlan.js";
import { Hono } from "hono";
import { beforeAll, bench, describe } from "vitest";
import type { Manifest } from "@aotter/mantle-spec";
import { InMemoryDatabase } from "../../../mantle-runtime/test/fakes/database.js";
import { createMantleRuntimeRef } from "../src/mount/bootRuntimeOnce.js";
import { mountTestEndpoints } from "./mountTestEndpoints.js";
import {
  StubAssetServer,
  stubAuth,
} from "./fakes/runtime-bindings.js";

const apiVersion = "cms.mantle.aotter.net/v1" as const;

function manifests(): Manifest[] {
  const accountInput = {
    type: "object",
    properties: { accountId: { type: "string" } },
    required: ["accountId"],
  } as const;
  const reservationInput = {
    type: "object",
    properties: {
      siteId: { type: "string" },
      operationId: { type: "string" },
    },
    required: ["siteId", "operationId"],
  } as const;
  return [
    {
      apiVersion,
      kind: "Schema",
      metadata: { name: "sites" },
      spec: {
        title: "Sites",
        schema: {
          type: "object",
          properties: { accountId: { type: "string" } },
          required: ["accountId"],
        },
        localized: false,
        lifecycle: "operational",
      },
    },
    {
      apiVersion,
      kind: "Procedure",
      metadata: { name: "require-account" },
      spec: {
        input: accountInput,
        output: { type: "object" },
        handler: { kind: "ref", ref: "requireAccount" },
      },
    },
    {
      apiVersion,
      kind: "View",
      metadata: { name: "sites-by-account" },
      spec: {
        surface: "public",
        from: "sites",
        params: accountInput,
        filter: { eq: { field: "accountId", value: { $param: "accountId" } } },
        requires: {
          auth: { all: ["ctx.auth", { "ctx.auth.scope": "sites:read" }] },
          guard: { procedure: "require-account" },
        },
      },
    },
    {
      apiVersion,
      kind: "Procedure",
      metadata: { name: "reserve-site" },
      spec: {
        input: reservationInput,
        output: {
          type: "object",
          properties: { reserved: { type: "boolean" } },
          required: ["reserved"],
        },
        handler: { kind: "ref", ref: "reserveSite" },
        requires: {
          auth: { all: ["ctx.auth", { "ctx.auth.scope": "sites:write" }] },
        },
      },
    },
    {
      apiVersion,
      kind: "Trigger",
      metadata: { name: "reserve-site-http" },
      spec: {
        source: { kind: "http", method: "POST", path: "/api/sites/{siteId}/reserve" },
        target: { procedure: "reserve-site" },
      },
    },
    {
      apiVersion,
      kind: "Procedure",
      metadata: { name: "create-site" },
      spec: {
        input: accountInput,
        output: { type: "object" },
        handler: { kind: "builtin", op: "create", schema: "sites" },
      },
    },
    {
      apiVersion,
      kind: "Trigger",
      metadata: { name: "create-site-http" },
      spec: {
        source: { kind: "http", method: "POST", path: "/api/sites" },
        target: { procedure: "create-site" },
      },
    },
  ];
}

function harness(): Hono {
  const ref = createMantleRuntimeRef({
    plan: compileTestPlan(manifests()),
    handlers: {
      requireAccount: () => ({}),
      reserveSite: () => ({ reserved: true }),
    },
    bindings: {
      db: new InMemoryDatabase(),
      adminAssets: new StubAssetServer(),
    },
    auth: stubAuth,
    credentialResolver: (request) => ({
      kind: "verified",
      credential: {
        credential: "api-key",
        credentialId: "bench-key",
        userId: null,
        scopes: request.method === "GET" ? ["sites:read"] : ["sites:write"],
      },
    }),
  });
  const app = new Hono();
  mountTestEndpoints(app, ref);
  return app;
}

const app = harness();
const headers = { "x-api-key": "bench-key" };

async function request(path: string, init?: RequestInit): Promise<void> {
  const response = await app.request(path, init);
  if (!response.ok) throw new Error(`benchmark request failed: ${response.status}`);
  await response.text();
}

beforeAll(async () => {
  await request("/api/views/sites-by-account?accountId=acct-1", { headers });
  await request("/api/sites/site-1/reserve", {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ operationId: "op-1" }),
  });
  await request("/api/sites", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ accountId: "acct-1" }),
  });
});

describe("warm native HTTP dispatch", () => {
  bench("guarded public View", async () => {
    await request("/api/views/sites-by-account?accountId=acct-1", { headers });
  });

  bench("Procedure HTTP Trigger", async () => {
    await request("/api/sites/site-1/reserve", {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ operationId: "op-1" }),
    });
  });

  bench("builtin write HTTP Trigger", async () => {
    await request("/api/sites", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ accountId: "acct-1" }),
    });
  });
});

for (const routes of [1, 10, 100, 1000]) {
  describe(`indexed Trigger dispatch / ${routes} routes`, () => {
    const plan = compileTestPlan([
      ...manifests().filter((manifest) => manifest.kind !== "Trigger"),
      ...Array.from({ length: routes }, (_, index): Manifest => ({
        apiVersion, kind: "Trigger", metadata: { name: `scaled-${index}` },
        spec: {
          source: { kind: "http", method: "POST", path: `/api/scaled-${String(index).padStart(4, "0")}/{siteId}` },
          target: { procedure: "reserve-site" },
        },
      })),
    ]);
    const scaled = new Hono();
    const ref = createMantleRuntimeRef({
      plan, handlers: { requireAccount: () => ({}), reserveSite: () => ({ reserved: true }) },
      bindings: { db: new InMemoryDatabase() }, auth: stubAuth,
      credentialResolver: () => ({ kind: "verified", credential: {
        credential: "api-key", credentialId: "bench-key", userId: null, scopes: ["sites:write"],
      } }),
    });
    mountTestEndpoints(scaled, ref);
    const run = async () => {
      const response = await scaled.request(`/api/scaled-${String(routes - 1).padStart(4, "0")}/site-1`, {
        method: "POST", headers: { "content-type": "application/json" }, body: '{"operationId":"op-1"}',
      });
      if (response.status !== 200) throw new Error(`scaled dispatch failed: ${response.status}`);
      await response.text();
    };
    beforeAll(run);
    bench("last route", run);
  });
}
