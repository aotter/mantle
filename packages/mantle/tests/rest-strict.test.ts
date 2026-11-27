/**
 * A strict route (a GET View Trigger, ADR-0047) reads its path parameters and query string through the View's own
 * reader and refuses a colliding, repeated or undeclared parameter before the database is opened; `page()` refuses a
 * bad limit or cursor before any data read. HEAD is answered only by the View's generated route.
 */
import { expect, test } from "bun:test";
import type { Caller } from "../src/kernel/contracts.js";
import { page, type Paged } from "../src/kernel/paging.js";
import { rest, type Route } from "../src/kernel/rest.js";
import { query } from "../src/kernel/validation.js";

type Db = { name: "db" };
const db: Db = { name: "db" };

function harness() {
  const count = { getDb: 0, read: 0 };
  const seen: { input?: unknown; sql?: string } = {};
  const spec: Paged<Db> = {
    path: "views/orders",
    cap: 100,
    sqlite: true,
    cursor: ["int"],
    keys: 1,
    values: {},
    read: (_db, sql) => {
      count.read++;
      seen.sql = sql;
      return [{ id: 1, _k0: 1 }];
    },
    caller: { binds: [], first: { sql: "first", extra: [-1] }, next: { sql: "next", extra: [0, -1] } },
  };
  const fields = [["id", "integer"], ["status"], ["urgent", "boolean"]] as const;
  const reader = (params: URLSearchParams) =>
    query(params, raw => raw as Record<string, unknown>, "views/orders", fields);
  const paged = (database: Db, caller: Caller, input: never, paging: { limit?: number; cursor?: string }) => {
    seen.input = input;
    return page(spec, database, caller, input, paging);
  };
  const target = { kind: "view", name: "orders" } as const;
  const routes: Route<Db>[] = [
    { method: "GET", pattern: /^\/api\/views\/orders\/?$/, target, query: reader, page: paged },
    {
      method: "GET",
      pattern: /^\/api\/orders\/([^/]+)\/?$/,
      keys: ["id"],
      id: "rest:GET /api/orders/:id",
      target,
      strict: true,
      query: reader,
      page: paged,
    },
    {
      method: "GET",
      pattern: /^\/api\/flags\/([^/]+)\/?$/,
      keys: ["urgent"],
      id: "rest:GET /api/flags/:urgent",
      target,
      strict: true,
      query: reader,
      page: paged,
    },
  ];
  const fetch = rest(routes, {
    db: () => {
      count.getDb++;
      return db;
    },
    caller: async () => ({ kind: "anonymous" }),
  });
  return { count, seen, fetch };
}

async function send(method: string, path: string) {
  const { count, seen, fetch } = harness();
  const response = (await fetch(new Request("https://app.test" + path, { method }), {}))!;
  const text = await response.text();
  const json = text ? JSON.parse(text) : null;
  return { response, json, count, seen };
}

const cursor = (operation: string) => encodeURIComponent(encodeURIComponent(JSON.stringify([5, 5, operation])));

test("strict refusals before the database is opened", async () => {
  // [path, message, error path]
  const rows: [string, string, string][] = [
    ["/api/orders/5?id=5", "Path parameter is repeated in the query string.", "views/orders/input/id"],
    ["/api/orders/5?status=a&status=b", "Query parameter is repeated.", "views/orders/input/status"],
    ["/api/orders/5?limit=1&limit=2", "Query parameter is repeated.", "views/orders/limit"],
    ["/api/orders/5?cursor=a&cursor=b", "Query parameter is repeated.", "views/orders/cursor"],
    ["/api/orders/5?id=5&id=6", "Path parameter is repeated in the query string.", "views/orders/input/id"],
    ["/api/orders/5?unknown=1", "Unknown query parameter.", "views/orders/input/unknown"],
    ["/api/orders/5?a%2Fb=1", "Unknown query parameter.", "views/orders/input/a~1b"],
    ["/api/orders/5?limit=x", "Expected a valid number.", "views/orders/limit"],
    ["/api/orders/abc", "Expected a valid number.", "views/orders/input/id"],
    ["/api/orders/1.5", "Expected a valid number.", "views/orders/input/id"],
    ["/api/flags/yes", "Expected true or false.", "views/orders/input/urgent"],
    ["/api/orders/5?urgent=1", "Expected true or false.", "views/orders/input/urgent"],
  ];
  for (const [path, message, at] of rows) {
    const { response, json, count } = await send("GET", path);
    expect([path, response.status, json.error, count]).toEqual([
      path,
      400,
      expect.objectContaining({ code: "INPUT_VALIDATION_FAILED", message, path: at }),
      { getDb: 0, read: 0 },
    ]);
  }
});

test("strict paging refusals before any data read", async () => {
  // [path, error path]
  const rows: [string, string][] = [
    ["/api/orders/5?limit=0", "views/orders/limit"],
    ["/api/orders/5?limit=-1", "views/orders/limit"],
    ["/api/orders/5?cursor=bogus", "views/orders/cursor"],
    ["/api/orders/5?cursor=%25", "views/orders/cursor"],
    [`/api/orders/5?cursor=${cursor("views/other")}`, "views/orders/cursor"],
  ];
  for (const [path, at] of rows) {
    const { response, json, count } = await send("GET", path);
    expect([path, response.status, json.error?.code, json.error?.path, count.read]).toEqual([
      path,
      400,
      "INPUT_VALIDATION_FAILED",
      at,
      0,
    ]);
    expect(count.getDb).toBeLessThanOrEqual(1);
  }
});

test("strict accepted requests", async () => {
  // [path, input the page receives, SQL read]
  const rows: [string, Record<string, unknown>, string][] = [
    ["/api/orders/5", { id: 5 }, "first"],
    ["/api/orders/5/", { id: 5 }, "first"],
    ["/api/orders/5?cursor=", { id: 5 }, "first"],
    ["/api/orders/%34%32", { id: 42 }, "first"],
    ["/api/orders/5?status=open&urgent=true&limit=2", { id: 5, status: "open", urgent: true }, "first"],
    [`/api/orders/5?cursor=${cursor("views/orders")}`, { id: 5 }, "next"],
    ["/api/flags/tru%65", { urgent: true }, "first"],
    ["/api/flags/false?status=a%20b", { urgent: false, status: "a b" }, "first"],
  ];
  for (const [path, input, sql] of rows) {
    const { response, json, count, seen } = await send("GET", path);
    expect([path, response.status, json.rows, seen.input, seen.sql, count]).toEqual([
      path,
      200,
      [{ id: 1 }],
      input,
      sql,
      { getDb: 1, read: 1 },
    ]);
  }
});

test("HEAD is answered by the View's generated route only", async () => {
  const strict = await send("HEAD", "/api/orders/5");
  expect([strict.response.status, strict.response.headers.get("allow"), strict.count]).toEqual([
    405,
    "GET",
    { getDb: 0, read: 0 },
  ]);
  const view = await send("HEAD", "/api/views/orders");
  expect([view.response.status, view.json, view.count]).toEqual([200, null, { getDb: 1, read: 1 }]);
});

test("the View's generated route keeps first-value-wins and ignores unknown keys", async () => {
  const { response, seen } = await send("GET", "/api/views/orders?status=a&status=b&unknown=1&id=5");
  expect([response.status, seen.input]).toEqual([200, { status: "a", id: 5 }]);
});
