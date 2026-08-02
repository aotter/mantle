import { describe, expect, it, vi } from "vitest";
import type { HandlerFn, Migration, MigrationRunner } from "@aotter/mantle-runtime";
import type { Manifest } from "@aotter/mantle-spec";
import { InMemoryDatabase } from "../../../mantle-runtime/test/fakes/database.js";
import { createSetupIncompleteAuth } from "../src/auth/createAuth.js";
import {
  createMantleWorker,
  runMantleWorkerRequest,
  type MantleCloudflareEnv,
} from "../src/worker/createMantleWorker.js";
import { InMemoryKv, StubAssetServer, stubAuth } from "./fakes/runtime-bindings.js";

const oauthState = vi.hoisted(() => ({ scopes: [] as string[] }));

vi.mock("@cloudflare/workers-oauth-provider", () => ({
  OAuthProvider: class<Env> {
    constructor(private readonly options: {
      readonly defaultHandler: ExportedHandler<Env>;
      readonly scopesSupported?: string[];
    }) {
      oauthState.scopes = options.scopesSupported ?? [];
    }
    fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
      const fetch = this.options.defaultHandler.fetch;
      if (!fetch) throw new Error("default handler fetch is missing");
      return fetch(request, env, ctx);
    }
  },
}));

type TestEnv = MantleCloudflareEnv & { readonly TEST_NAME?: string };

describe("createMantleWorker", () => {
  it("gives low-level compositions the same private error boundary", async () => {
    const response = await runMantleWorkerRequest(() => {
      throw new Error("sensitive boot failure");
    });

    expect(response.status).toBe(500);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    await expect(response.json()).resolves.toEqual({ ok: false, error: "internal_error" });
  });

  it("assembles an extension once and applies the shared cache boundary", async () => {
    let extensions = 0;
    const worker = createMantleWorker<TestEnv>({
      manifest: [],
      auth: () => stubAuth,
      bindings: () => ({
        db: new InMemoryDatabase(),
        kv: new InMemoryKv(),
        assets: new StubAssetServer(),
      }),
      extend: ({ env }) => {
        extensions += 1;
        return {
          mount: ({ app }) => {
            app.get("/health", (c) => new Response(c.env.TEST_NAME ?? env.TEST_NAME ?? "ok", {
              headers: { "cache-control": "public, s-maxage=60" },
            }));
          },
        };
      },
    });
    const env = testEnv({ TEST_NAME: "same-stack" });

    const first = await fetchWorker(worker, "/health", env);
    const second = await fetchWorker(worker, "/health", env);

    expect(await first.text()).toBe("same-stack");
    expect(second.headers.get("cache-control")).toBe("public, s-maxage=60");
    expect(second.headers.get("vary")).toBe("Cookie, Authorization");
    expect(extensions).toBe(1);
  });

  it("blocks auth surfaces when conventional auth is incomplete", async () => {
    const worker = createMantleWorker<TestEnv>({
      manifest: [],
      bindings: () => ({
        db: new InMemoryDatabase(),
        kv: new InMemoryKv(),
        assets: new StubAssetServer(),
      }),
    });

    const response = await fetchWorker(worker, "/admin", testEnv());

    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    await expect(response.json()).resolves.toMatchObject({ error: "setup_incomplete" });
  });

  it("preserves a custom setup response but forces the auth surface private", async () => {
    const worker = createMantleWorker<TestEnv>({
      manifest: [],
      auth: () => createSetupIncompleteAuth({
        message: "Connect your owner account.",
        response: () => new Response("custom setup", {
          status: 200,
          headers: {
            "cache-control": "public, s-maxage=3600",
            "cloudflare-cdn-cache-control": "public, max-age=3600",
            "x-setup": "custom",
          },
        }),
      }),
      bindings: () => ({
        db: new InMemoryDatabase(),
        kv: new InMemoryKv(),
        assets: new StubAssetServer(),
      }),
    });

    const response = await fetchWorker(worker, "/admin", testEnv());

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("custom setup");
    expect(response.headers.get("x-setup")).toBe("custom");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.has("cloudflare-cdn-cache-control")).toBe(false);
  });

  it("keeps the mandatory MCP scope when an extension adds scopes", async () => {
    const worker = createMantleWorker<TestEnv>({
      manifest: [],
      auth: () => stubAuth,
      bindings: () => ({
        db: new InMemoryDatabase(),
        kv: new InMemoryKv(),
        assets: new StubAssetServer(),
      }),
      extend: () => ({ scopesSupported: ["platform:read", "mcp"] }),
    });

    await fetchWorker(worker, "/health", testEnv());

    expect(oauthState.scopes).toEqual(["mcp", "platform:read"]);
  });

  it("accepts prototype-named handler refs and exposes the stable site probe", async () => {
    const worker = createMantleWorker<TestEnv>({
      manifest: [],
      handlers: { base: () => ({}) },
      auth: () => stubAuth,
      bindings: () => ({
        db: new InMemoryDatabase(),
        kv: new InMemoryKv(),
        assets: new StubAssetServer(),
      }),
      extend: () => ({ handlers: { toString: () => ({}) } }),
    });

    const response = await fetchWorker(worker, "/favicon.svg", testEnv());

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("image/svg+xml");
    expect(response.headers.get("x-mantle-site")).toBe("v1");
  });

  it("rejects empty or malformed locale arrays on either Wrangler representation", async () => {
    for (const locales of [[], [42], "[]", '[" "]'] as unknown[]) {
      const worker = createMantleWorker<TestEnv>({
        manifest: [],
        auth: () => stubAuth,
        bindings: () => ({
          db: new InMemoryDatabase(),
          kv: new InMemoryKv(),
          assets: new StubAssetServer(),
        }),
      });
      const env = testEnv({ MANTLE_SITE_LOCALES: locales as readonly string[] });

      const response = await fetchWorker(worker, "/favicon.svg", env);

      expect(response.status).toBe(500);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
    }
  });

  it("fails fast when the conventional OAuth KV binding is missing", async () => {
    const worker = createMantleWorker<TestEnv>({ manifest: [] });
    const env = { ...testEnv(), OAUTH_KV: undefined as never };

    const response = await fetchWorker(worker, "/", env);

    expect(response.status).toBe(500);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });

  it("passes Worker env and waitUntil to custom Procedure handlers", async () => {
    const manifest: Manifest[] = [
      {
        apiVersion: "cms.mantle.aotter.net/v1",
        kind: "Procedure",
        metadata: { name: "env-probe" },
        spec: {
          input: { type: "object", additionalProperties: false },
          output: {
            type: "object",
            required: ["name"],
            properties: { name: { type: "string" } },
          },
          handler: { kind: "ref", ref: "envProbe" },
        },
      },
      {
        apiVersion: "cms.mantle.aotter.net/v1",
        kind: "Trigger",
        metadata: { name: "env-probe-http" },
        spec: {
          source: { kind: "http", method: "POST", path: "/api/env-probe" },
          target: { procedure: "env-probe" },
        },
      },
    ];
    const envProbe: HandlerFn<Record<string, never>, { name: string }, TestEnv> = (_input, ctx) => {
      expect(typeof ctx.waitUntil).toBe("function");
      return { name: ctx.env.TEST_NAME ?? "" };
    };
    const worker = createMantleWorker<TestEnv>({
      manifest,
      handlers: { envProbe },
      auth: () => stubAuth,
      bindings: () => ({
        db: new InMemoryDatabase(),
        kv: new InMemoryKv(),
        assets: new StubAssetServer(),
      }),
    });

    const response = await fetchWorker(worker, "/api/env-probe", testEnv({ TEST_NAME: "visible" }), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ data: { name: "visible" } });
  });

  it("retries runtime boot after a transient rejection", async () => {
    const db = new FailFirstMigrationDatabase();
    const worker = createMantleWorker<TestEnv>({
      manifest: [],
      auth: () => stubAuth,
      bindings: () => ({ db, kv: new InMemoryKv(), assets: new StubAssetServer() }),
      extend: () => ({
        mount: ({ app, getRuntime }) => {
          app.get("/probe", async () => {
            await getRuntime();
            return new Response("ready");
          });
        },
      }),
    });
    const env = testEnv();

    const first = await fetchWorker(worker, "/probe", env);
    const second = await fetchWorker(worker, "/probe", env);

    expect(first.status).toBe(500);
    expect(first.headers.get("cache-control")).toBe("private, no-store");
    expect(second.status).toBe(200);
    expect(await second.text()).toBe("ready");
    expect(db.migrationAttempts).toBeGreaterThanOrEqual(2);
  });
});

class FailFirstMigrationDatabase extends InMemoryDatabase {
  migrationAttempts = 0;
  override migrations: MigrationRunner = {
    runAll: async (migrations: readonly Migration[]) => {
      this.migrationAttempts += 1;
      if (this.migrationAttempts === 1) throw new Error("transient migration failure");
      for (const migration of migrations) this.appliedMigrations.add(migration.id);
    },
  };
}

function testEnv(extra: Partial<TestEnv> = {}): TestEnv {
  return {
    DB: {} as D1Database,
    KV: {} as KVNamespace,
    OAUTH_KV: {} as KVNamespace,
    ...extra,
  };
}

function fetchWorker(
  worker: ExportedHandler<TestEnv>,
  path: string,
  env: TestEnv,
  init?: RequestInit,
): Promise<Response> {
  if (!worker.fetch) throw new Error("worker fetch is missing");
  return worker.fetch(
    new Request(`https://site.test${path}`, init),
    env,
    {
      waitUntil() {},
      passThroughOnException() {},
      props: {},
    } as unknown as ExecutionContext,
  );
}
