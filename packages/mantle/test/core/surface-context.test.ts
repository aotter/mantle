import { DatabaseSync } from "node:sqlite";
import ts from "typescript";
import { beforeAll, describe, expect, it } from "vitest";
import { compilePlan } from "../../src/spec/index.js";
import { createMantle, createMantleRuntime, withCaller, type Caller, type DatabaseDriver, type HandlerContext, type RuntimePlan, type Surface } from "../../src/core/index.js";
import { sqliteStorage } from "../../src/d1/index.js";
import { createRestSurface } from "../../src/web/index.js";
import { createAdminSurface } from "../../src/admin/index.js";
import { createMcpSurface } from "../../src/mcp/index.js";
import { presetFiles } from "../../src/cli/preset.js";

const manifests = `apiVersion: cms.mantle.aotter.net/v2
kind: Schema
metadata: { name: items }
spec: { title: Items, lifecycle: operational, schema: { type: object, properties: { name: { type: string } } } }
---
apiVersion: cms.mantle.aotter.net/v2
kind: View
metadata: { name: items }
spec: { surface: public, sql: "SELECT name FROM items ORDER BY name" }
---
apiVersion: cms.mantle.aotter.net/v2
kind: Procedure
metadata: { name: add }
spec: { input: { type: object, required: [name], properties: { name: { type: string } } }, output: { type: object }, handler: { ref: add } }
---
apiVersion: cms.mantle.aotter.net/v2
kind: Procedure
metadata: { name: audit }
spec: { input: { type: object }, output: { type: object }, handler: { ref: audit } }
---
apiVersion: cms.mantle.aotter.net/v2
kind: Trigger
metadata: { name: add-http }
spec: { source: { kind: http, method: POST, path: /api/items }, target: { procedure: add } }
---
apiVersion: cms.mantle.aotter.net/v2
kind: Trigger
metadata: { name: add-mcp }
spec: { source: { kind: mcp, surface: public }, target: { procedure: add } }
---
apiVersion: cms.mantle.aotter.net/v2
kind: Trigger
metadata: { name: add-staff }
spec: { source: { kind: mcp, surface: staff }, target: { procedure: add } }
---
apiVersion: cms.mantle.aotter.net/v2
kind: Trigger
metadata: { name: audit-items }
spec: { source: { kind: lifecycle, schema: items, on: [after_create] }, target: { procedure: audit } }
`;
let plan: RuntimePlan;
beforeAll(async () => {
  const result = await compilePlan({ sources: [{ sourceId: "surface-context", text: manifests }] });
  if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
  plan = result.plan;
});

function storage() {
  const db = new DatabaseSync(":memory:");
  const driver: DatabaseDriver = { async batch(statements) {
    db.exec("BEGIN");
    try {
      const result = statements.map(({ sql, binds = [] }) => {
        const statement = db.prepare(sql);
        const values = binds.map((v) => typeof v === "boolean" ? Number(v) : v ?? null) as (string | number | bigint | null)[];
        return { rows: statement.columns().length ? statement.all(...values).map((r) => ({ ...r })) : (statement.run(...values), []) };
      });
      db.exec("COMMIT");
      return result;
    } catch (error) { db.exec("ROLLBACK"); throw error; }
  } };
  return { adapter: sqliteStorage(driver), close: () => db.close() };
}

const caller: Caller = { kind: "user", subject: "owner", role: "owner", scopes: [], credential: "session", credentialId: null, clientId: null };
type Kind = "rest" | "admin" | "mcp";
function instance(kind: Kind) {
  const db = storage();
  let mounted = 0;
  let routes: ReturnType<typeof withCaller> | undefined;
  let release!: () => void;
  let started!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const entered = new Promise<void>((resolve) => { started = resolve; });
  const handlers = {
    add: async (input: { name: string }, ctx: HandlerContext) => {
      if (input.name === "held") { started(); await held; }
      await ctx.store.write([{ insert: "items", values: input }]);
      ctx.waitUntil(Promise.resolve(`handler:${input.name}`));
      return {};
    },
    audit: (_input: unknown, ctx: HandlerContext) => {
      if (ctx.cause.kind === "lifecycle") ctx.waitUntil(Promise.resolve(`hook:${ctx.cause.rows[0]?.name}`));
      return {};
    },
  };
  const mantle = createMantle({ handlers: handlers as never, fetch(request, _env, { runtime }) {
    if (!routes) {
      mounted++;
      const surface: Surface = kind === "rest" ? createRestSurface(runtime, { basePath: "/api" })
        : kind === "admin" ? createAdminSurface(runtime, { basePath: "/admin" })
        : createMcpSurface(runtime, { basePath: "/mcp", surface: "public" });
      routes = withCaller(async () => ({ caller }), surface);
    }
    return routes(request, runtime);
  } }, { plan, storage: () => db.adapter });
  return { mantle, close: db.close, mounted: () => mounted, release: () => release(), entered };
}

function write(kind: Kind, name: string) {
  const path = kind === "rest" ? "/api/items" : kind === "admin" ? "/admin/api/operations/add" : "/mcp";
  const body = kind === "mcp" ? { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "add", arguments: { name } } } : { name };
  return new Request(`https://service.test${path}`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", origin: "https://service.test" }, body: JSON.stringify(body) });
}
async function drain(pending: Promise<unknown>[]) {
  const values: unknown[] = [];
  for (let consumed = 0; consumed < pending.length;) {
    const batch = pending.slice(consumed);
    consumed += batch.length;
    values.push(...await Promise.all(batch));
  }
  return values.filter((v) => typeof v === "string");
}

describe.each<Kind>(["rest", "admin", "mcp"])("cached %s dispatch", (kind) => {
  it("uses each sequential/concurrent request's handler and after-hook retainer without remounting", async () => {
    const app = instance(kind);
    const fetch = async (name: string, pending: Promise<unknown>[]) => {
      const response = await app.mantle.fetch(write(kind, name), {}, { waitUntil: (p) => { pending.push(p); } });
      // MCP returns a streaming response before the tool completes; consume it before inspecting its retained work.
      await response.text();
      return response;
    };
    try {
      for (const name of ["first", "second"]) {
        const pending: Promise<unknown>[] = [];
        expect((await fetch(name, pending)).status).toBe(200);
        expect(await drain(pending)).toEqual(expect.arrayContaining([`handler:${name}`, `hook:${name}`]));
      }
      if (kind === "admin") {
        const pending: Promise<unknown>[] = [];
        const response = await app.mantle.fetch(new Request("https://service.test/admin/api/entries", {
          method: "POST", headers: { "content-type": "application/json", origin: "https://service.test" },
          body: JSON.stringify({ collection: "items", data: { name: "direct" } }),
        }), {}, { waitUntil: (p) => { pending.push(p); } });
        expect(response.status).toBe(200);
        expect(await drain(pending)).toContain("hook:direct");
      }
      const a: Promise<unknown>[] = [], b: Promise<unknown>[] = [];
      const first = fetch("held", a);
      await app.entered;
      expect((await fetch("other", b)).status).toBe(200);
      app.release();
      expect((await first).status).toBe(200);
      expect(await drain(a)).toEqual(expect.arrayContaining(["handler:held", "hook:held"]));
      expect(await drain(b)).toEqual(expect.arrayContaining(["handler:other", "hook:other"]));
      expect(await drain(a)).not.toContain("hook:other");
      expect(await drain(b)).not.toContain("hook:held");
      expect(app.mounted()).toBe(1);
    } finally { app.release(); app.close(); }
  });
});

it("separate compositions of the same plan keep writes and cached reads on their own storage", async () => {
  const a = instance("rest"), b = instance("rest");
  try {
    for (const [app, name] of [[a, "a"], [b, "b"], [a, "a2"]] as const) expect((await app.mantle.fetch(write("rest", name), {})).status).toBe(200);
    const read = async (app: typeof a) => (await (await app.mantle.fetch(new Request("https://service.test/api/views/items"), {})).json()).rows;
    expect(await read(a)).toEqual([{ name: "a" }, { name: "a2" }]);
    expect(await read(b)).toEqual([{ name: "b" }]);
    expect([a.mounted(), b.mounted()]).toEqual([1, 1]);
  } finally { a.close(); b.close(); }
});

it("the generated factory isolates storage and auth retries while reusing initialized routes", async () => {
  const a = storage(), b = storage();
  let authStarts = 0, transportStarts = 0;
  // An auth provider whose first start fails, as a transient migration/startup failure would.
  const auth = {
    createSetupIncompleteAuth: () => ({ ready: ++authStarts === 1 ? Promise.reject(new Error("auth startup")) : Promise.resolve() }),
    createCallerResolver: () => async () => ({ caller }),
    createAuthRoutes: () => async () => null,
  };
  const handlers = { add: async (input: { name: string }, ctx: HandlerContext) => { await ctx.store.write([{ insert: "items", values: input }]); return {}; }, audit: () => ({}) };
  const source = Object.fromEntries(presetFiles("/tmp/generated-instance-test", { host: "cloudflare", identity: "mantle", dialect: "sqlite", features: ["mcp"] }, plan))["src/service.ts"]!;
  const modules: Record<string, unknown> = {
    "@aotter/mantle": { createMantle, withCaller },
    "@aotter/mantle/auth": auth,
    "@aotter/mantle/cloudflare": { d1Storage: (driver: typeof a.adapter) => driver },
    "@aotter/mantle/mcp": { createMcpSurface: (...args: Parameters<typeof createMcpSurface>) => { transportStarts++; return createMcpSurface(...args); }, planApp: () => ({ name: "staff", uri: "ui://staff", html: "<html></html>" }) },
    "@aotter/mantle-ui/mcp-app": { mantleAppHtml: "<html></html>" },
    "@aotter/mantle/web": { createRestSurface },
    "../.mantle/generated/mantle.js": { plan },
    "./handlers.js": { handlers },
  };
  const output = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const exports: { createService?: () => ReturnType<typeof createMantle> } = {};
  new Function("require", "exports", output)((name: string) => {
    if (!(name in modules)) throw new Error(`unexpected generated import ${name}`);
    return modules[name];
  }, exports);
  const left = exports.createService!(), right = exports.createService!();
  const envA = { DB: a.adapter }, envB = { DB: b.adapter };
  try {
    await expect(left.fetch(write("rest", "failed"), envA)).rejects.toThrow("auth startup");
    expect((await right.fetch(write("rest", "b"), envB)).status).toBe(200);
    expect((await left.fetch(write("rest", "a"), envA)).status).toBe(200);
    expect((await right.fetch(write("rest", "b2"), envB)).status).toBe(200);
    const read = async (app: typeof left, env: typeof envA) => (await (await app.fetch(new Request("https://service.test/api/views/items"), env)).json()).rows;
    expect(await read(left, envA)).toEqual([{ name: "a" }]);
    expect(await read(right, envB)).toEqual([{ name: "b" }, { name: "b2" }]);
    expect(authStarts).toBe(3); // right is not reset by left's failure/retry
    expect(transportStarts).toBe(6); // public + staff per mount, including the failed mount; none per later request
  } finally { a.close(); b.close(); }
});

it("one cached MCP handler retains subscription limits across execution facades and releases cancelled streams", async () => {
  const db = storage();
  const runtime = await createMantleRuntime({ plan, handlers: { add: () => ({}), audit: () => ({}) }, storage: db.adapter });
  const surface = createMcpSurface(runtime, { basePath: "/mcp", surface: "public" });
  const aborts: AbortController[] = [];
  const readers: ReadableStreamDefaultReader<Uint8Array>[] = [];
  const listen = (id: number, signal?: AbortSignal) => surface(new Request("https://service.test/mcp", {
    method: "POST", signal, headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2026-07-28", "mcp-method": "subscriptions/listen" },
    body: JSON.stringify({ jsonrpc: "2.0", id, method: "subscriptions/listen", params: { notifications: {}, _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientCapabilities": {} } } }),
  }), caller, { ...runtime });
  try {
    for (let i = 0; i < 32; i++) {
      const abort = new AbortController(); aborts.push(abort);
      const response = await listen(i, abort.signal);
      expect(response.headers.get("content-type")).toContain("text/event-stream");
      const reader = response.body!.getReader(); readers.push(reader);
      expect(new TextDecoder().decode((await reader.read()).value)).toContain("notifications/subscriptions/acknowledged");
    }
    const refused = await listen(33);
    expect(await refused.text()).toContain("Subscription limit reached");
    aborts[0]!.abort();
    expect((await readers[0]!.read()).done).toBe(true);
    const replacement = new AbortController(); aborts.push(replacement);
    const reopened = await listen(34, replacement.signal);
    expect(reopened.headers.get("content-type")).toContain("text/event-stream");
    const reader = reopened.body!.getReader(); readers.push(reader);
    expect(new TextDecoder().decode((await reader.read()).value)).toContain("acknowledged");
  } finally {
    aborts.forEach((abort) => abort.abort());
    await Promise.all(readers.map((reader) => reader.cancel()));
    db.close();
  }
});

it("the generated Bun factory uses each host native pool and releases every operation", async () => {
  const stores = [storage(), storage()];
  const pools = stores.map((_store, owner) => {
    const counts = { checkouts: 0, releases: 0 };
    const client = {
      query: async () => ({ rows: [{ owner }], fields: [], rowCount: 1 }),
      release: () => { counts.releases++; },
    };
    return { counts, pool: { async connect() { counts.checkouts++; return client; } } };
  });
  const source = Object.fromEntries(presetFiles("/tmp/generated-pool-test", { host: "bun", identity: "none", dialect: "postgres", features: [] }, plan))["src/service.ts"]!;
  const handlers = { add: async (input: { name: string }, ctx: HandlerContext) => { await ctx.store.write([{ insert: "items", values: input }]); return {}; }, audit: () => ({}) };
  // Only the engine is substituted; the generated native pool acquisition is real.
  const modules: Record<string, unknown> = {
    "@aotter/mantle": { createMantle },
    "@aotter/mantle/postgres": { postgresStorage: ({ connect }: { connect: () => Promise<any> }) => ({
      dialect: stores[0]!.adapter.dialect,
      async prepare(plan: RuntimePlan) {
        const lease = await connect();
        let owner: number;
        try { owner = (await lease.query("storage owner")).rows[0].owner; } finally { lease.release(); }
        const prepared = await stores[owner!]!.adapter.prepare(plan);
        const borrow = async <T,>(run: () => Promise<T>) => {
          const client = await connect();
          try { await client.query("operation"); return await run(); } finally { client.release(); }
        };
        return { ...prepared, executor: { ...prepared.executor,
          select: (...args: Parameters<typeof prepared.executor.select>) => borrow(() => prepared.executor.select(...args)),
          apply: (...args: Parameters<typeof prepared.executor.apply>) => borrow(() => prepared.executor.apply(...args)),
        } };
      },
    }) },
    "@aotter/mantle/web": { createRestSurface },
    "../.mantle/generated/mantle.js": { plan }, "./handlers.js": { handlers },
  };
  const exports: { createService?: () => ReturnType<typeof createMantle> } = {};
  new Function("require", "exports", ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText)((name: string) => modules[name] ?? (() => { throw new Error(name); })(), exports);
  const a = exports.createService!(), b = exports.createService!();
  try {
    for (const [app, i, name] of [[a, 0, "a"], [b, 1, "b"], [a, 0, "a2"]] as const) expect((await app.fetch(write("rest", name), { PG: pools[i]!.pool })).status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(pools.map((p) => p.counts)).toEqual([{ checkouts: 3, releases: 3 }, { checkouts: 2, releases: 2 }]);
  } finally { stores.forEach((store) => store.close()); }
});
