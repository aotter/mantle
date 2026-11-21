import { test, expect, spyOn } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { generateOrThrow, writeGenerated } from "./apps/link.js";
import { fixtureCaller } from "./apps/fixtures.js";
import { ContractError, type Authorize, type Caller, type Target } from "../src/kernel/contracts.js";
import { mcpInit } from "./mcp-wire.js";

const doc = (kind: string, name: string, spec: object) =>
  JSON.stringify({ apiVersion: "cms.mantle.aotter.net/v2", kind, metadata: { name }, spec });
const source = [
  doc("Schema", "notes", {
    title: "Notes",
    lifecycle: "operational",
    schema: { type: "object", properties: { title: { type: "string" } }, required: ["title"] },
  }),
  doc("View", "list-notes", {
    surface: "public",
    requires: { auth: { all: ["ctx.user"] } },
    sql: "SELECT id FROM notes ORDER BY id",
  }),
  doc("View", "open-notes", { surface: "public", sql: "SELECT id FROM notes ORDER BY id" }),
  doc("Procedure", "echo-notes", {
    requires: { auth: { all: ["ctx.admin"] } },
    input: { type: "object", additionalProperties: false },
    output: { type: "object" },
    handler: { ref: "app.echo" },
  }),
  doc("Trigger", "echo-http", {
    source: { kind: "http", method: "POST", path: "/api/echo" },
    target: { procedure: "echo-notes" },
  }),
  doc("Trigger", "echo-mcp", { source: { kind: "mcp", surface: "public" }, target: { procedure: "echo-notes" } }),
].join("\n---\n");
const admin: Caller = fixtureCaller({
  kind: "user",
  subject: "a",
  role: "admin",
  admin: true,
  scopes: ["mcp"],
  credential: "oauth",
  credentialId: null,
  clientId: null,
});
const cases: readonly [Authorize | undefined, number][] = [
  [undefined, 200],
  [() => true, 200],
  [async () => true, 200],
  [() => false, 403],
  [async () => false, 403],
  [() => Promise.reject(Error("refused")), 403],
  [
    () => {
      throw Error("broken");
    },
    500,
  ],
];

async function fixture(run: (dir: string, db: Database) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "mantle-authorize-")),
    db = new Database(":memory:");
  const log = spyOn(console, "error").mockImplementation(() => {});
  try {
    const files = await generateOrThrow("bun-sqlite", [{ sourceId: "authorize.yaml", text: source }]);
    await writeGenerated(dir, files);
    db.exec(files["schema.sql"]!);
    await run(dir, db);
  } finally {
    log.mockRestore();
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
}

test("generated REST authorizes manifest targets before SQL/handlers, with requires first", async () =>
  fixture(async (dir, db) => {
    const { rest } = await import(join(dir, "rest.ts"));
    for (const [authorize, status] of cases)
      for (const [path, method, target] of [
        ["/api/views/list-notes", "GET", { kind: "view", name: "list-notes" }],
        ["/api/echo", "POST", { kind: "procedure", name: "echo-notes" }],
      ] as const) {
        let providers = 0,
          handlers = 0,
          calls = 0;
        const fetch = rest({
          db: () => {
            providers++;
            return db;
          },
          caller: () => admin,
          handlers: {
            "echo-notes": () => {
              handlers++;
              return { ok: true };
            },
          },
          ...(authorize
            ? {
                authorize: (t: Target, c: Caller) => {
                  calls++;
                  expect(t).toEqual(target);
                  expect(c).toBe(admin);
                  return authorize(t, c);
                },
              }
            : {}),
        });
        const response = await fetch(
          new Request("https://app.test" + path, { method, ...(method === "POST" ? { body: "{}" } : {}) }),
          {},
        );
        expect(response.status).toBe(status);
        expect(providers).toBe(status === 200 ? 1 : 0);
        expect(handlers).toBe(status === 200 && method === "POST" ? 1 : 0);
        expect(calls).toBe(authorize ? 1 : 0);
        if (status === 403) expect((await response.json()).error.code).toBe("AUTH_DENIED");
      }
    let authorizations = 0;
    const fetch = rest({
      db: () => {
        throw Error("SQL before requires");
      },
      caller: () => ({ kind: "anonymous" }),
      handlers: {
        "echo-notes": () => {
          throw Error("handler before requires");
        },
      },
      authorize: () => {
        authorizations++;
        return true;
      },
    });
    for (const [path, method] of [
      ["/api/views/list-notes", "GET"],
      ["/api/echo", "POST"],
    ])
      expect(
        (
          await fetch(
            new Request("https://app.test" + path, { method, body: method === "POST" ? "{}" : undefined }),
            {},
          )
        ).status,
      ).toBe(401);
    expect(authorizations).toBe(0);
    const publicFetch = rest({
      db: () => {
        throw Error("denied public SQL");
      },
      caller: () => ({ kind: "anonymous" }),
      handlers: {},
      authorize: () => false,
    });
    expect((await publicFetch(new Request("https://app.test/api/views/open-notes"), {})).status).toBe(403);
  }));

test("generated MCP authorizes calls and filters lists using requires and manifest names", async () =>
  fixture(async (dir, db) => {
    const { mcp } = await import(join(dir, "mcp.ts"));
    const ask = async (
      fetch: (request: Request, env: object) => Promise<Response>,
      method: string,
      params: object = {},
    ) => {
      const response = await fetch(
        new Request(
          "https://app.test/mcp",
          mcpInit(
            { jsonrpc: "2.0", id: 1, method, params },
            { headers: { "content-type": "application/json", accept: "application/json, text/event-stream" } },
          ),
        ),
        {},
      );
      const text = await response.text();
      return {
        response,
        data: JSON.parse(text.startsWith("event:") ? text.split("data: ")[1]!.split("\n")[0]! : text),
      };
    };
    for (const [authorize, status] of cases)
      for (const [name, target] of [
        ["list_notes", { kind: "view", name: "list-notes" }],
        ["echo_notes", { kind: "procedure", name: "echo-notes" }],
      ] as const) {
        let providers = 0,
          handlers = 0;
        const fetch = mcp({
          db: () => {
            providers++;
            return db;
          },
          caller: () => admin,
          handlers: {
            "echo-notes": () => {
              handlers++;
              return { ok: true };
            },
          },
          ...(authorize
            ? {
                authorize: (t: Target, c: Caller) => {
                  expect(t).toEqual(target);
                  expect(c).toBe(admin);
                  return authorize(t, c);
                },
              }
            : {}),
        });
        const result = await ask(fetch, "tools/call", { name, arguments: {} });
        expect(result.response.status).toBe(status);
        expect(providers).toBe(status === 200 ? 1 : 0);
        expect(handlers).toBe(status === 200 && name === "echo_notes" ? 1 : 0);
        if (status === 200) expect(result.data.result.isError).toBeUndefined();
        if (status === 403) expect(result.data.error.code).toBe("AUTH_DENIED");
      }
    for (const [authorize, status] of cases) {
      const fetch = mcp({
        apps: {
          public: { resources: [{ uri: "ui://notes", name: "notes", html: "<p>Notes</p>", renders: ["list_notes"] }] },
        },
        db: () => {
          throw Error("listing SQL");
        },
        caller: () => admin,
        handlers: {
          "echo-notes": () => {
            throw Error("listing handler");
          },
        },
        ...(authorize ? { authorize } : {}),
      });
      const result = await ask(fetch, "tools/list");
      expect(result.response.status).toBe(status === 500 ? 500 : 200);
      if (status !== 500)
        expect(result.data.result.tools.map((t: { name: string }) => t.name)).toEqual(
          status === 403 ? [] : ["list_notes", "open_notes", "echo_notes"],
        );
    }
    const seen: Target[] = [];
    const fetch = mcp({
      db: () => {
        throw Error("requires SQL");
      },
      caller: () => ({ kind: "anonymous" }),
      handlers: {},
      authorize: async (t: Target) => {
        seen.push(t);
        return true;
      },
    });
    expect((await ask(fetch, "tools/list")).data.result.tools.map((t: { name: string }) => t.name)).toEqual([
      "open_notes",
    ]);
    expect(seen).toEqual([{ kind: "view", name: "open-notes" }]);
    seen.length = 0;
    expect((await ask(fetch, "tools/call", { name: "list_notes", arguments: {} })).response.status).toBe(401);
    expect(seen).toEqual([]);
    // discovery "all": one list for every caller, authorize decides at call time, and its AUTH_DENIED reason is kept
    const reason = "Only a manager may call echo-notes.";
    const decide = async (t: Target) =>
      t.name !== "echo-notes" || Promise.reject(new ContractError("AUTH_DENIED", reason, "procedure/echo-notes"));
    const loaders: string[][] = [];
    const all = mcp({
      discovery: "all",
      apps: {
        public: {
          resources: [
            {
              uri: "ui://notes",
              name: "notes",
              html: ({ tools }: { tools: ReadonlySet<string> }) => {
                loaders.push([...tools]);
                return "<p>Notes</p>";
              },
              renders: ["list_notes"],
            },
          ],
        },
      },
      db: () => db,
      caller: () => admin,
      handlers: { "echo-notes": () => ({ ok: true }) },
      authorize: decide,
    });
    const filtered = mcp({
      db: () => db,
      caller: () => admin,
      handlers: { "echo-notes": () => ({ ok: true }) },
      authorize: decide,
    });
    expect((await ask(all, "tools/list")).data.result.tools.map((t: { name: string }) => t.name)).toEqual([
      "list_notes",
      "open_notes",
      "echo_notes",
    ]);
    expect((await ask(filtered, "tools/list")).data.result.tools.map((t: { name: string }) => t.name)).toEqual([
      "list_notes",
      "open_notes",
    ]);
    await ask(all, "resources/read", { uri: "ui://notes" });
    expect(loaders).toEqual([["list_notes", "open_notes", "echo_notes"]]);
    for (const fetch of [all, filtered]) {
      const denied = await ask(fetch, "tools/call", { name: "echo_notes", arguments: {} });
      expect(denied.response.status).toBe(403);
      expect(denied.data.error).toMatchObject({ code: "AUTH_DENIED", message: reason });
    }
    expect((await ask(all, "tools/call", { name: "list_notes", arguments: {} })).response.status).toBe(200);
    // a plain false, or any other rejection, still answers the generic refusal
    const plain = mcp({
      discovery: "all",
      db: () => db,
      caller: () => admin,
      handlers: {},
      authorize: async () => Promise.reject(Error("internal detail")),
    });
    expect((await ask(plain, "tools/call", { name: "list_notes", arguments: {} })).data.error).toMatchObject({
      code: "AUTH_DENIED",
      message: "Target is not authorized.",
    });
  }));

test("a handler's 429 keeps its status and retryAfter; from authorize it is 403 AUTH_DENIED; handlers' own calls skip authorize", async () =>
  fixture(async (dir, db) => {
    const { rest } = await import(join(dir, "rest.ts"));
    const { mcp } = await import(join(dir, "mcp.ts"));
    const limited = () =>
      new ContractError("RATE_LIMITED", "Too many notes.", "procedures/echo-notes", {
        status: 429,
        fields: { retryAfter: 60 },
      });
    const viaRest = async (options: object) => {
      const response = (await rest({ db: () => db, caller: () => admin, ...options })(
        new Request("https://app.test/api/echo", { method: "POST", body: "{}" }),
        {},
      ))!;
      return { status: response.status, retryAfter: response.headers.get("retry-after"), body: await response.json() };
    };
    const viaMcp = async (options: object, method = "tools/call") => {
      const response = await mcp({ db: () => db, caller: () => admin, ...options })(
        new Request(
          "https://app.test/mcp",
          mcpInit(
            {
              jsonrpc: "2.0",
              id: 1,
              method,
              params: method === "tools/call" ? { name: "echo_notes", arguments: {} } : {},
            },
            { headers: { "content-type": "application/json", accept: "application/json, text/event-stream" } },
          ),
        ),
        {},
      );
      const text = await response.text();
      return {
        status: response.status,
        data: JSON.parse(text.startsWith("event:") ? text.split("data: ")[1]!.split("\n")[0]! : text),
      };
    };
    const error = { code: "RATE_LIMITED", message: "Too many notes.", path: "procedures/echo-notes", retryAfter: 60 };

    // From a ref handler: REST answers 429 with retryAfter in the body and sets no header; MCP an error result.
    const throwing = {
      handlers: {
        "echo-notes": () => {
          throw limited();
        },
      },
    };
    expect(await viaRest(throwing)).toEqual({ status: 429, retryAfter: null, body: { error } });
    const tool = await viaMcp(throwing);
    expect([tool.data.result.isError, JSON.parse(tool.data.result.content[0].text)]).toEqual([
      true,
      { diagnostics: [error] },
    ]);

    // From authorize: 403 AUTH_DENIED with the generic message, retryAfter dropped, on REST and MCP.
    const refusing = {
      handlers: { "echo-notes": () => ({ ok: true }) },
      authorize: async () => Promise.reject(limited()),
    };
    const denied = { code: "AUTH_DENIED", message: "Target is not authorized.", path: "procedure/echo-notes" };
    expect(await viaRest(refusing)).toEqual({ status: 403, retryAfter: null, body: { error: denied } });
    const refused = await viaMcp(refusing);
    expect([refused.status, refused.data.error]).toEqual([403, denied]);

    // An AUTH_DENIED ContractError keeps its message on REST too.
    const reason = new ContractError("AUTH_DENIED", "Only a manager may call echo-notes.", "procedure/echo-notes");
    expect(await viaRest({ handlers: {}, authorize: async () => Promise.reject(reason) })).toEqual({
      status: 403,
      retryAfter: null,
      body: { error: { code: "AUTH_DENIED", message: reason.message, path: "procedure/echo-notes" } },
    });

    // A View the handler calls through its store is application code: authorize, which refuses that View, is not asked.
    const seen: Target[] = [];
    const nested = await viaRest({
      handlers: { "echo-notes": async ({ store }: any) => ({ notes: (await store.views["list-notes"]({})).length }) },
      authorize: (target: Target) => {
        seen.push(target);
        return target.name !== "list-notes";
      },
    });
    expect([nested.status, nested.body, seen]).toEqual([
      200,
      { notes: 0 },
      [{ kind: "procedure", name: "echo-notes" }],
    ]);

    // tools/list asks authorize once per tool.
    seen.length = 0;
    await viaMcp({ handlers: {}, authorize: (target: Target) => seen.push(target) > 0 }, "tools/list");
    expect(seen.map(target => target.name)).toEqual(["list-notes", "open-notes", "echo-notes"]);
  }));
