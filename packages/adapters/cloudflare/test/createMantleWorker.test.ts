import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type {
  HandlerFn,
  MediaStorage,
  Migration,
  MigrationRunner,
} from "@aotter/mantle-runtime";
import type { Manifest } from "@aotter/mantle-spec";
import { InMemoryDatabase } from "../../../mantle-runtime/test/fakes/database.js";
import { D1DatabaseDriver } from "../src/bindings/D1DatabaseDriver.js";
import {
  MANTLE_RESERVED_EXACT_PATHS,
  MANTLE_RESERVED_PATH_PREFIXES,
  MANTLE_RESERVED_WELL_KNOWN_PREFIX,
  createMantleWorker,
  type MantleCloudflareEnv,
  type MantleWorkerHandler,
} from "../src/worker/createMantleWorker.js";
import { StubAssetServer, stubAuth } from "./fakes/runtime-bindings.js";

const oauthState = vi.hoisted(() => ({
  scopes: [] as string[],
  tokenExchangeCallback: undefined as undefined | ((options: {
    readonly userId: string;
    readonly clientId: string;
    readonly requestedScope: string[];
  }) => unknown),
}));

vi.mock("@cloudflare/workers-oauth-provider", () => ({
  OAuthProvider: class<Env> {
    constructor(private readonly options: {
      readonly defaultHandler: ExportedHandler<Env>;
      readonly scopesSupported?: string[];
      readonly tokenExchangeCallback?: typeof oauthState.tokenExchangeCallback;
    }) {
      oauthState.scopes = options.scopesSupported ?? [];
      oauthState.tokenExchangeCallback = options.tokenExchangeCallback;
    }
    fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
      const pathname = new URL(request.url).pathname;
      if (
        pathname === "/oauth/token" ||
        pathname === "/oauth/register" ||
        pathname.startsWith("/.well-known/oauth") ||
        ((pathname === "/mcp" || pathname.startsWith("/mcp/")) &&
          !request.headers.has("authorization"))
      ) return Promise.resolve(new Response("oauth transport"));
      const fetch = this.options.defaultHandler.fetch;
      if (!fetch) throw new Error("default handler fetch is missing");
      return fetch(request, env, ctx);
    }
  },
}));

type TestEnv = MantleCloudflareEnv & { readonly TEST_NAME?: string };

describe("createMantleWorker", () => {
  it("keeps the canonical docs aligned with the route contract", async () => {
    const docs = await readFile(
      fileURLToPath(new URL("../../../mantle/README.md", import.meta.url)),
      "utf8",
    );
    for (const path of [
      ...MANTLE_RESERVED_PATH_PREFIXES,
      MANTLE_RESERVED_WELL_KNOWN_PREFIX,
      ...MANTLE_RESERVED_EXACT_PATHS,
    ]) {
      expect(docs).toContain(`\`${path}`);
    }
  });

  it("assembles once, boots a no-handler manifest, and exposes real Worker context", async () => {
    let assemblies = 0;
    const worker = createMantleWorker<TestEnv>({
      manifest: [],
      auth: () => stubAuth,
      bindings: testBindings,
      extend: ({ env }) => {
        assemblies += 1;
        return {
          mount: ({ app, getRuntime }) => {
            app.get("/health", async (c) => {
              await getRuntime();
              return c.text(c.env.TEST_NAME ?? env.TEST_NAME ?? "ok");
            });
          },
        };
      },
    });
    const env = testEnv({ TEST_NAME: "same-stack" });

    const [first, second] = await Promise.all([
      fetchWorker(worker, "/health", env),
      fetchWorker(worker, "/health", env),
    ]);

    expect(await first.text()).toBe("same-stack");
    expect(await second.text()).toBe("same-stack");
    expect(assemblies).toBe(1);
  });

  it("boots migrations before the first Auth request", async () => {
    const db = new InMemoryDatabase();
    const worker = createMantleWorker<TestEnv>({
      manifest: [],
      auth: () => stubAuth,
      bindings: () => ({ db, assets: new StubAssetServer() }),
    });

    await fetchWorker(worker, "/api/auth/probe", testEnv());

    expect(db.appliedMigrations.size).toBeGreaterThan(0);
  });

  it("does not boot the CMS runtime for OAuth transport-only requests", async () => {
    const db = new InMemoryDatabase();
    const worker = createMantleWorker<TestEnv>({
      manifest: [],
      auth: () => stubAuth,
      bindings: () => ({ db, assets: new StubAssetServer() }),
    });

    for (const path of [
      "/.well-known/oauth-authorization-server",
      "/.well-known/oauth-protected-resource/mcp/staff",
      "/oauth/register",
      "/oauth/token",
      "/mcp/staff",
    ]) {
      expect((await fetchWorker(worker, path, testEnv())).status, path).toBe(200);
    }

    expect(db.appliedMigrations.size).toBe(0);
    await fetchWorker(worker, "/oauth/authorize", testEnv());
    expect(db.appliedMigrations.size).toBeGreaterThan(0);
  });

  it("passes Env and waitUntil to typed handlers", async () => {
    const handler: HandlerFn<Record<string, never>, { name: string }, TestEnv> = (_input, ctx) => {
      expect(typeof ctx.waitUntil).toBe("function");
      return { name: `${ctx.env.TEST_NAME}:${ctx.auth?.credential}` };
    };
    const worker = createMantleWorker<TestEnv>({
      manifest: envProbeManifests(),
      handlers: { envProbe: handler },
      auth: () => stubAuth,
      bindings: testBindings,
      extend: () => ({
        credentialResolver: (request) => request.headers.get("authorization") === "Bearer site-pat"
          ? {
              kind: "verified",
              credential: {
                credential: "personal-token",
                credentialId: "pat-1",
                userId: "user-1",
              },
            }
          : { kind: "not-handled" },
      }),
    });

    const response = await fetchWorker(
      worker,
      "/api/env-probe",
      testEnv({ TEST_NAME: "visible" }),
      {
        method: "POST",
        headers: {
          authorization: "Bearer site-pat",
          "content-type": "application/json",
        },
        body: "{}",
      },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      data: { name: "visible:personal-token" },
    });
  });

  it("passes a facade OAuth audience to the existing Auth verifier", async () => {
    const verifyOAuthAccessToken = vi.fn(async () => ({
      ok: true as const,
      userId: "user-1",
      clientId: "platform-client",
      credentialId: "jwt-1",
      scopes: ["platform:read"],
    }));
    const handler: HandlerFn<Record<string, never>, { name: string }, TestEnv> = (_input, ctx) => ({
      name: ctx.auth?.credential ?? "anonymous",
    });
    const worker = createMantleWorker<TestEnv>({
      manifest: envProbeManifests(),
      handlers: { envProbe: handler },
      auth: () => ({ ...stubAuth, verifyOAuthAccessToken }),
      bindings: testBindings,
      extend: () => ({
        jwtBearer: { audience: "https://platform.test/api", scopes: ["platform:read"] },
      }),
    });

    const response = await fetchWorker(worker, "/api/env-probe", testEnv(), {
      method: "POST",
      headers: {
        authorization: "Bearer jwt",
        "content-type": "application/json",
      },
      body: "{}",
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ data: { name: "oauth" } });
    expect(verifyOAuthAccessToken).toHaveBeenCalledWith(expect.any(Request), {
      audience: "https://platform.test/api",
      scopes: ["platform:read"],
    });
  });

  it("applies the public cache contract once after extension dispatch", async () => {
    const worker = createMantleWorker<TestEnv>({
      manifest: [],
      auth: () => stubAuth,
      bindings: testBindings,
      extend: () => ({
        mount: ({ app }) => {
          app.get("/public", () => new Response("public", {
            headers: { "cache-control": "public, s-maxage=60" },
          }));
        },
      }),
    });

    const anonymous = await fetchWorker(worker, "/public", testEnv());
    expect(anonymous.headers.get("cache-control")).toBe("public, s-maxage=60");
    expect(anonymous.headers.get("vary")).toBe("Cookie, Authorization");
    const credentialed = await fetchWorker(worker, "/public", testEnv(), {
      headers: { cookie: "session=secret" },
    });
    expect(credentialed.headers.get("cache-control")).toBe("private, no-store");
  });

  it("exposes the conventional binding stack before an override", async () => {
    const mediaStorage = {} as MediaStorage;
    const worker = createMantleWorker<TestEnv>({
      manifest: [],
      auth: () => stubAuth,
      bindings: (_env, conventional) => {
        expect(conventional.db).toBeInstanceOf(D1DatabaseDriver);
        return { ...testBindings(), mediaStorage };
      },
      extend: ({ bindings }) => ({
        mount: ({ app }) => {
          app.get("/media-ready", (c) => c.text(String(bindings.mediaStorage === mediaStorage)));
        },
      }),
    });

    expect(await (await fetchWorker(worker, "/media-ready", testEnv())).text()).toBe("true");
  });

  it("keeps public routes available while incomplete Auth blocks private surfaces", async () => {
    const worker = createMantleWorker<TestEnv>({
      manifest: [],
      bindings: testBindings,
      extend: () => ({ mount: ({ app }) => void app.get("/health", (c) => c.text("ok")) }),
    });

    expect((await fetchWorker(worker, "/health", testEnv())).status).toBe(200);
    const response = await fetchWorker(worker, "/admin", testEnv());
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });

  it("redacts missing binding failures at the Worker boundary", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const worker = createMantleWorker<TestEnv>({ manifest: [] });
    const response = await fetchWorker(
      worker,
      "/",
      { ...testEnv(), OAUTH_KV: undefined as never },
    );

    expect(response.status).toBe(500);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    await expect(response.json()).resolves.toEqual({ ok: false, error: "internal_error" });
    expect(error.mock.calls.flat().join(" ")).toContain("OAUTH_KV");
    error.mockRestore();
  });

  it("rejects dynamic reserved routes and custom Auth namespaces before serving", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    for (const path of ["/admin/custom", "/admin*", "/private-auth/callback", "*"]) {
      const worker = createMantleWorker<TestEnv>({
        manifest: [],
        auth: () => ({ ...stubAuth, basePath: "/private-auth" }),
        bindings: testBindings,
        extend: () => ({
          mount: ({ app }) => {
            const dynamic: string = path;
            app.get(dynamic, (c) => c.text("unsafe"));
          },
        }),
      });

      const response = await fetchWorker(worker, "/", testEnv());
      expect(response.status, path).toBe(500);
      expect(response.headers.get("cache-control"), path).toBe("private, no-store");
    }
    error.mockRestore();
  });

  it("rejects a dynamic duplicate of a manifest-owned route", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const manifest: Manifest[] = [
      {
        apiVersion: "cms.mantle.aotter.net/v1",
        kind: "Procedure",
        metadata: { name: "hook" },
        spec: {
          input: { type: "object" },
          output: { type: "object" },
          handler: { kind: "ref", ref: "hook" },
        },
      },
      {
        apiVersion: "cms.mantle.aotter.net/v1",
        kind: "Trigger",
        metadata: { name: "hook-http" },
        spec: {
          source: { kind: "http", method: "POST", path: "/hooks/probe" },
          target: { procedure: "hook" },
        },
      },
    ];
    const worker = createMantleWorker<TestEnv>({
      manifest,
      auth: () => stubAuth,
      bindings: testBindings,
      extend: () => ({
        mount: ({ app }) => {
          const path: string = "/hooks/probe";
          app.post(path, (c) => c.text("duplicate"));
        },
      }),
    });

    expect((await fetchWorker(worker, "/", testEnv())).status).toBe(500);
    error.mockRestore();
  });

  it("retries runtime boot after a transient rejection", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const db = new FailFirstMigrationDatabase();
    const worker = createMantleWorker<TestEnv>({
      manifest: [],
      auth: () => stubAuth,
      bindings: () => ({ db, assets: new StubAssetServer() }),
      extend: () => ({
        mount: ({ app, getRuntime }) => {
          app.get("/probe", async (c) => {
            await getRuntime();
            return c.text("ready");
          });
        },
      }),
    });

    expect((await fetchWorker(worker, "/probe", testEnv())).status).toBe(500);
    expect((await fetchWorker(worker, "/probe", testEnv())).status).toBe(200);
    expect(db.migrationAttempts).toBeGreaterThanOrEqual(2);
    error.mockRestore();
  });

  it("keeps mcp once when an extension adds OAuth scopes", async () => {
    const worker = createMantleWorker<TestEnv>({
      manifest: [],
      auth: () => stubAuth,
      bindings: testBindings,
      extend: () => ({ scopesSupported: ["platform:read", "mcp"] }),
    });

    await fetchWorker(worker, "/favicon.svg", testEnv());
    expect(oauthState.scopes).toEqual(["mcp", "platform:read"]);
  });

  it("puts the effective access-token scope in API props", async () => {
    const worker = createMantleWorker<TestEnv>({
      manifest: [],
      auth: () => stubAuth,
      bindings: testBindings,
    });
    await fetchWorker(worker, "/favicon.svg", testEnv());

    expect(oauthState.tokenExchangeCallback?.({
      userId: "user-1",
      clientId: "client-1",
      requestedScope: ["sites.read"],
    })).toEqual({
      accessTokenProps: {
        userId: "user-1",
        clientId: "client-1",
        scopes: ["sites.read"],
      },
    });
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

function envProbeManifests(): Manifest[] {
  return [
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
}

function testBindings() {
  return {
    db: new InMemoryDatabase(),
    assets: new StubAssetServer(),
  };
}

function testEnv(extra: Partial<TestEnv> = {}): TestEnv {
  return {
    DB: {} as D1Database,
    OAUTH_KV: {} as KVNamespace,
    ...extra,
  };
}

function fetchWorker(
  worker: MantleWorkerHandler<TestEnv>,
  path: string,
  env: TestEnv,
  init?: RequestInit,
): Promise<Response> {
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
