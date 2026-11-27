import { fixtureCaller } from "./apps/fixtures.js";
import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateOrThrow, writeGenerated } from "./apps/link.js";
export const source = `apiVersion: cms.mantle.aotter.net/v2
kind: Schema
metadata: {name: notes}
spec:
 title: Notes
 lifecycle: operational
 schema: {type: object, required: [title], properties: {title: {type: string}}}
---
apiVersion: cms.mantle.aotter.net/v2
kind: View
metadata: {name: notes}
spec:
 surface: public
 sql: SELECT id,title FROM notes ORDER BY id
---
apiVersion: cms.mantle.aotter.net/v2
kind: View
metadata: {name: secret}
spec:
 surface: internal
 sql: SELECT id FROM notes ORDER BY id
---
apiVersion: cms.mantle.aotter.net/v2
kind: Procedure
metadata: {name: edit}
spec:
 requires: {auth: {all: [ctx.admin]}}
 input: {type: object, required: [id,title,version], properties: {id: {type: string}, title: {type: string}, version: {type: integer}}, additionalProperties: false}
 output: {type: object}
 handler: {sql: 'UPDATE notes SET title=input.title WHERE id=input.id AND version=input.version RETURNING id,title'}
---
apiVersion: cms.mantle.aotter.net/v2
kind: Trigger
metadata: {name: edit-http}
spec:
 source: {kind: http, method: PUT, path: '/api/notes/{id}'}
 target: {procedure: edit}
---
apiVersion: cms.mantle.aotter.net/v2
kind: View
metadata: {name: note-titles}
spec:
 surface: public
 requires: {auth: {all: [ctx.user]}}
 input: {type: object, properties: {title: {type: string}, after: {type: string}}, additionalProperties: false}
 sql: SELECT id,title FROM notes WHERE (input.title IS NULL OR title=input.title) AND (input.after IS NULL OR id > input.after) ORDER BY id
---
apiVersion: cms.mantle.aotter.net/v2
kind: Trigger
metadata: {name: note-titles-get}
spec:
 source: {kind: http, method: GET, path: '/api/titles/{title}'}
 target: {view: note-titles}
`;
const user = (
  role: string | null = "admin",
  credential: import("../src/kernel/contracts.js").CredentialKind = "oauth",
) =>
  fixtureCaller({
    kind: "user",
    subject: "s",
    role,
    admin: role === "admin",
    scopes: [],
    credential,
    credentialId: null,
    clientId: null,
  });
test("REST selected routes: paging, validation, auth, OCC, method, composition and session origin", async () => {
  const files = await generateOrThrow("bun-sqlite", [{ sourceId: "rest.yaml", text: source }]);
  expect(files["rest.ts"]).not.toContain("secret.js");
  const dir = await mkdtemp(join(tmpdir(), "mantle-rest-")),
    db = new Database(":memory:");
  try {
    await writeGenerated(dir, files);
    db.exec(files["schema.sql"]!);
    for (const id of ["a", "b", "c"])
      db.query("INSERT INTO notes(id,version,created_at,updated_at,title) VALUES (?,1,0,0,?)").run(id, id);
    let caller: any = { kind: "anonymous" },
      calls = 0;
    const { rest } = await import(join(dir, "rest.ts"));
    const fetch = rest({
      db: () => db,
      caller: async () => {
        calls++;
        return caller;
      },
    });
    const request = (path: string, method = "GET", body?: string, headers?: Record<string, string>) =>
      fetch(new Request("https://app.test" + path, { method, body, headers }), {});
    const first = await request("/api/views/notes?limit=1");
    expect(first.status).toBe(200);
    expect(first.headers.get("cache-control")).toBe("private, no-store");
    const page = await first.json();
    expect(page.rows).toEqual([{ id: "a", title: "a" }]);
    expect(
      (await (await request("/api/views/notes?limit=1&cursor=" + encodeURIComponent(page.nextCursor))).json()).rows,
    ).toEqual([{ id: "b", title: "b" }]);
    expect((await request("/api/%76iews/notes")).status).toBe(200);
    expect((await request("/api/views/notes?limit=bad")).status).toBe(400);
    expect((await request("/api/notes/a", "PUT", '{"title":"x","version":1}')).status).toBe(401);
    caller = user(null);
    expect((await request("/api/notes/a", "PUT", '{"title":"x","version":1}')).status).toBe(403);
    caller = user();
    expect((await request("/api/notes/a", "PUT", '{"title":"x","version":1}')).status).toBe(200);
    expect((await request("/api/notes/a", "PUT", '{"title":"x","version":1}')).status).toBe(409);
    for (const body of ["{", "[]", '{"title":3,"version":2}', '{"title":"x","version":2.5}'])
      expect((await request("/api/notes/a", "PUT", body)).status).toBe(400);
    expect((await request("/api/views/secret")).status).toBe(404);
    const method = await request("/api/views/notes", "POST");
    expect(method.status).toBe(405);
    expect(method.headers.get("allow")).toBe("GET");
    expect((await request("/api/notes/a")).status).toBe(405);
    expect((await request("/api/unknown")).status).toBe(404);
    const before = calls;
    expect(await request("/custom")).toBeUndefined();
    expect(await request("/custom/%ZZ")).toBeUndefined();
    expect(calls).toBe(before);
    const oversized = new Request("https://app.test/api/notes/a", {
      method: "PUT",
      body: "{}",
      headers: { "content-length": "1000001" },
    });
    expect((await fetch(oversized, {})).status).toBe(400);
    expect(oversized.bodyUsed).toBe(true); // refused on its declared length, then drained (bounded) for the next request
    expect(
      (await request("/api/notes/a", "PUT", JSON.stringify({ title: "😀".repeat(300000), version: 2 }))).status,
    ).toBe(400);
    caller = user("admin", "session");
    for (const headers of [
      {} as Record<string, string>,
      { origin: "https://evil.test" },
      { "sec-fetch-site": "cross-site", origin: "https://app.test" },
    ])
      expect((await request("/api/notes/a", "PUT", '{"title":"y","version":2}', headers)).status).toBe(403);
    expect(
      (
        await (
          await request("/api/notes/a", "PUT", '{"title":"y","version":2}', { origin: "https://evil.test" })
        ).json()
      ).error.path,
    ).toBe("request:origin");
    expect(
      (await request("/api/notes/a", "PUT", '{"title":"y","version":2}', { origin: "https://app.test" })).status,
    ).toBe(200);
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
test("REST clones query values before driver conversion and prioritizes static Trigger paths", async () => {
  const text =
    source.replace(
      "sql: SELECT id,title FROM notes ORDER BY id",
      "input: {type: object, required: [title], properties: {title: {type: string}}, additionalProperties: false}\n sql: SELECT id,title FROM notes WHERE title=input.title ORDER BY id",
    ) +
    `---
apiVersion: cms.mantle.aotter.net/v2
kind: Trigger
metadata: {name: search-http}
spec:
 source: {kind: http, method: PUT, path: /api/notes/search}
 target: {procedure: edit}
`;
  const files = await generateOrThrow("bun-sqlite", [{ sourceId: "rest.yaml", text }]),
    dir = await mkdtemp(join(tmpdir(), "mantle-rest-input-")),
    db = new Database(":memory:");
  try {
    await writeGenerated(dir, files);
    db.exec(files["schema.sql"]!);
    db.exec("INSERT INTO notes(id,version,created_at,updated_at,title) VALUES ('a',1,0,0,'a')");
    const { rest } = await import(join(dir, "rest.ts")),
      fetch = rest({ db: () => db, caller: async () => user() });
    const view = await fetch(new Request("https://app.test/api/views/notes?title=a"), {});
    expect(view.status).toBe(200);
    expect((await view.json()).rows).toEqual([{ id: "a", title: "a" }]);
    const result = await fetch(
      new Request("https://app.test/api/notes/search", {
        method: "PUT",
        body: JSON.stringify({ id: "a", title: "static", version: 1 }),
      }),
      {},
    );
    expect(result.status).toBe(200);
    expect(db.query("SELECT title FROM notes").get()).toEqual({ title: "static" });
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
test("REST-only startup references exposed operations within the existing Worker budget", async () => {
  const { writeFile } = await import("node:fs/promises"),
    { bundle, startupGraph } = await import("../src/infrastructure/bundle.js");
  const files = await generateOrThrow("cloudflare-d1", [{ sourceId: "rest.yaml", text: source }]);
  const dir = await mkdtemp(join(import.meta.dir, "apps/.rest-size-"));
  try {
    await writeGenerated(dir, files, false);
    const entry = join(dir, "worker.ts");
    await writeFile(
      entry,
      'import {rest} from "./rest.js"; export default {fetch:rest({db:(env:any)=>env.DB,caller:async()=>({kind:"anonymous"} as const)})};',
    );
    const meta = await bundle(entry, join(dir, "dist")),
      graph = startupGraph(meta, entry),
      bytes = graph.reduce((sum, path) => sum + meta.outputs[path]!.bytes, 0);
    const budgets = JSON.parse(
      await (await import("node:fs/promises")).readFile(join(import.meta.dir, "../size-budgets.json"), "utf8"),
    );
    expect(bytes).toBeLessThanOrEqual(budgets["cloudflare-d1"]);
    const output = await (await import("node:fs/promises")).readFile(join(process.cwd(), graph[0]!), "utf8");
    expect(output).not.toContain("SELECT id FROM notes");
    console.log(JSON.stringify({ entry: "rest-only", startupBytes: bytes, budgetBytes: budgets["cloudflare-d1"] }));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
// Legacy behavior pinned for #2174: the generated `/api/views/<name>` route keeps first-value-wins, ignores unknown
// query keys, silently clamps a large limit and answers HEAD; write-Trigger paths answer only their method.
test("REST legacy table: View route query reading, HEAD, 405 and NOT_FOUND", async () => {
  const text = source.replace(
    "sql: SELECT id,title FROM notes ORDER BY id",
    "input: {type: object, required: [title], properties: {title: {type: string}}, additionalProperties: false}\n sql: SELECT id,title FROM notes WHERE title=input.title ORDER BY id",
  );
  const files = await generateOrThrow("bun-sqlite", [{ sourceId: "rest.yaml", text }]),
    dir = await mkdtemp(join(tmpdir(), "mantle-rest-legacy-")),
    db = new Database(":memory:");
  try {
    await writeGenerated(dir, files);
    db.exec(files["schema.sql"]!);
    for (const id of ["a", "b", "c"])
      db.query("INSERT INTO notes(id,version,created_at,updated_at,title) VALUES (?,1,0,0,'t')").run(id);
    const { rest } = await import(join(dir, "rest.ts")),
      fetch = rest({ db: () => db, caller: async () => ({ kind: "anonymous" }) });
    const all = ["a", "b", "c"],
      invalid = (path: string) => ({ code: "INPUT_VALIDATION_FAILED", path: "views/notes/" + path });
    // [method, path, status, Allow header, rows or error]
    const rows: [string, string, number, string | null, string[] | { code: string; path: string } | null][] = [
      ["GET", "/api/views/notes?title=t", 200, null, all],
      ["GET", "/api/views/notes?title=t&title=x", 200, null, all],
      ["GET", "/api/views/notes?title=x&title=t", 200, null, []],
      ["GET", "/api/views/notes?title=t&unknown=1", 200, null, all],
      ["GET", "/api/views/notes?title=t&limit=1&limit=2", 200, null, ["a"]],
      ["GET", "/api/views/notes?title=t&limit=100000", 200, null, all],
      ["GET", "/api/views/notes?title=t&cursor=", 200, null, all],
      ["GET", "/api/views/notes/?title=t", 200, null, all],
      ["GET", "/api/views/notes?title=t&limit=0", 400, null, invalid("limit")],
      ["GET", "/api/views/notes?title=t&limit=-1", 400, null, invalid("limit")],
      ["GET", "/api/views/notes?title=t&limit=x", 400, null, invalid("limit")],
      ["GET", "/api/views/notes?title=t&cursor=bogus", 400, null, invalid("cursor")],
      ["GET", "/api/views/notes", 400, null, invalid("input/title")],
      ["HEAD", "/api/views/notes?title=t", 200, null, null],
      ["POST", "/api/views/notes?title=t", 405, "GET", { code: "METHOD_NOT_ALLOWED", path: "rest" }],
      ["GET", "/api/notes/a", 405, "PUT", { code: "METHOD_NOT_ALLOWED", path: "rest" }],
      ["HEAD", "/api/notes/a", 405, "PUT", { code: "METHOD_NOT_ALLOWED", path: "rest" }],
      ["DELETE", "/api/notes/a", 405, "PUT", { code: "METHOD_NOT_ALLOWED", path: "rest" }],
      ["GET", "/api/unknown", 404, null, { code: "NOT_FOUND", path: "rest" }],
      ["GET", "/api/views/secret", 404, null, { code: "NOT_FOUND", path: "rest" }],
    ];
    for (const row of rows) {
      const [method, path] = row,
        response = await fetch(new Request("https://app.test" + path, { method }), {}),
        body = await response.text(),
        json = body ? JSON.parse(body) : null;
      const outcome = json?.error
        ? { code: json.error.code, path: json.error.path }
        : (json?.rows?.map((r: { id: string }) => r.id) ?? null);
      expect([method, path, response.status, response.headers.get("allow"), outcome]).toEqual(row);
    }
    // The clamp is observable only above 500 rows: a limit past the page bound answers 500 rows and a next cursor.
    for (let i = 0; i < 498; i++)
      db.query("INSERT INTO notes(id,version,created_at,updated_at,title) VALUES (?,1,0,0,'t')").run(
        "d" + String(i).padStart(3, "0"),
      );
    for (const path of ["/api/views/notes?title=t&limit=100000", "/api/views/notes?title=t&limit=501"]) {
      const response = await fetch(new Request("https://app.test" + path), {}),
        page = await response.json();
      expect([path, response.status, page.rows.length, typeof page.nextCursor]).toEqual([path, 200, 500, "string"]);
    }
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
// GET View Triggers (ADR-0047): a custom GET path over the View's own reader and page, strict about its query string.
test("REST GET View Trigger: path parameter, filters, paging, auth and strict refusals before any read", async () => {
  const files = await generateOrThrow("bun-sqlite", [{ sourceId: "rest.yaml", text: source }]),
    dir = await mkdtemp(join(tmpdir(), "mantle-rest-get-trigger-")),
    db = new Database(":memory:");
  try {
    await writeGenerated(dir, files);
    db.exec(files["schema.sql"]!);
    for (const [id, title] of [
      ["a", "t"],
      ["b", "t"],
      ["c", "t"],
      ["d", "u"],
      ["e", "a b"],
    ] as const)
      db.query("INSERT INTO notes(id,version,created_at,updated_at,title) VALUES (?,1,0,0,?)").run(id, title);
    // Every statement the generated page runs goes through `query` or `prepare`.
    let reads = 0,
      caller: any = user(null);
    const counted = new Proxy(db, {
      get(target, key) {
        if (key === "query" || key === "prepare") reads++;
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const { rest } = await import(join(dir, "rest.ts")),
      fetch = rest({ db: () => counted, caller: async () => caller });
    const call = async (path: string, method = "GET") => {
      reads = 0;
      const response = await fetch(new Request("https://app.test" + path, { method }), {}),
        text = await response.text(),
        json = text ? JSON.parse(text) : null;
      return { response, json, read: reads > 0 };
    };
    const first = await call("/api/titles/t?limit=1");
    const builtIn = await call("/api/views/note-titles?title=t&limit=1");
    const notes = await call("/api/views/notes?limit=1");
    const cursor = (json: any) => encodeURIComponent(json.nextCursor);
    const invalid = (path: string) => ({ code: "INPUT_VALIDATION_FAILED", path: "views/note-titles/" + path });
    const methodNotAllowed = { code: "METHOD_NOT_ALLOWED", path: "rest" };
    // [method, path, status, Allow header, rows or error, read the database]
    const rows: [string, string, number, string | null, string[] | { code: string; path: string } | null, boolean][] = [
      ["GET", "/api/titles/t", 200, null, ["a", "b", "c"], true],
      ["GET", "/api/titles/t/", 200, null, ["a", "b", "c"], true],
      ["GET", "/api/titles/u", 200, null, ["d"], true],
      ["GET", "/api/titles/%74", 200, null, ["a", "b", "c"], true],
      ["GET", "/api/titles/a%20b", 200, null, ["e"], true],
      ["GET", "/api/titles/t?after=a", 200, null, ["b", "c"], true],
      ["GET", "/api/titles/t?after=a&limit=1", 200, null, ["b"], true],
      ["GET", `/api/titles/t?limit=1&cursor=${cursor(first.json)}`, 200, null, ["b"], true],
      // Cursors stay bound to the View: one from its generated route continues on the custom path.
      ["GET", `/api/titles/t?limit=1&cursor=${cursor(builtIn.json)}`, 200, null, ["b"], true],
      ["GET", "/api/titles/t?cursor=", 200, null, ["a", "b", "c"], true],
      ["GET", "/api/titles/t?limit=100000", 200, null, ["a", "b", "c"], true],
      ["GET", "/api/titles/x", 200, null, [], true],
      ["GET", "/api/titles/t?title=u", 400, null, invalid("input/title"), false],
      ["GET", "/api/titles/t?after=a&after=b", 400, null, invalid("input/after"), false],
      ["GET", "/api/titles/t?limit=1&limit=2", 400, null, invalid("limit"), false],
      ["GET", "/api/titles/t?cursor=a&cursor=b", 400, null, invalid("cursor"), false],
      ["GET", "/api/titles/t?unknown=1", 400, null, invalid("input/unknown"), false],
      ["GET", "/api/titles/t?limit=x", 400, null, invalid("limit"), false],
      ["GET", "/api/titles/t?limit=0", 400, null, invalid("limit"), false],
      ["GET", "/api/titles/t?limit=-1", 400, null, invalid("limit"), false],
      ["GET", "/api/titles/t?cursor=bogus", 400, null, invalid("cursor"), false],
      ["GET", `/api/titles/t?cursor=${cursor(notes.json)}`, 400, null, invalid("cursor"), false],
      ["HEAD", "/api/titles/t", 405, "GET", methodNotAllowed, false],
      ["POST", "/api/titles/t", 405, "GET", methodNotAllowed, false],
      ["GET", "/api/titles", 404, null, { code: "NOT_FOUND", path: "rest" }, false],
      ["GET", "/api/titles/t/x", 404, null, { code: "NOT_FOUND", path: "rest" }, false],
      // The View's generated route keeps its own reading and HEAD.
      ["GET", "/api/views/note-titles?title=t&title=u&unknown=1", 200, null, ["a", "b", "c"], true],
      ["HEAD", "/api/views/note-titles?title=t", 200, null, null, true],
    ];
    for (const row of rows) {
      const [method, path] = row,
        { response, json, read } = await call(path, method);
      const outcome = json?.error
        ? { code: json.error.code, path: json.error.path }
        : (json?.rows?.map((r: { id: string }) => r.id) ?? null);
      expect([method, path, response.status, response.headers.get("allow"), outcome, read]).toEqual(row);
    }
    // The View's `requires` guards the custom path too, before any read.
    caller = { kind: "anonymous" };
    const anonymous = await call("/api/titles/t");
    expect([anonymous.response.status, anonymous.json.error.path, anonymous.read]).toEqual([
      401,
      "views/note-titles/requires/auth/all/0",
      false,
    ]);
    expect(files["rest.ts"]).toContain('id: "rest:GET /api/titles/:title"');
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
