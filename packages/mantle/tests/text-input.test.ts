import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { generateOrThrow, writeGenerated } from "./apps/link.js";
import { fixtureCaller } from "./apps/fixtures.js";

// #1973: every string input is well-formed text without NUL, and x-mantle-maxBytes bounds its UTF-8 length.
const source = `apiVersion: cms.mantle.aotter.net/v2
kind: Schema
metadata: {name: notes}
spec:
  title: Notes
  lifecycle: operational
  schema: {type: object, properties: {title: {type: string}}}
---
apiVersion: cms.mantle.aotter.net/v2
kind: View
metadata: {name: notes}
spec:
  surface: public
  input: {type: object, properties: {title: {type: string}}, additionalProperties: false}
  sql: 'SELECT id, title FROM notes WHERE input.title IS NULL OR title = input.title ORDER BY id'
---
apiVersion: cms.mantle.aotter.net/v2
kind: Procedure
metadata: {name: add-note}
spec:
  input:
    type: object
    additionalProperties: false
    required: [title]
    properties:
      title: {type: string, maxLength: 10, x-mantle-maxBytes: 12}
      tags: {type: array, items: {type: string}}
  output: {type: object}
  handler: {sql: 'INSERT INTO notes(title) VALUES(input.title) RETURNING id'}
---
apiVersion: cms.mantle.aotter.net/v2
kind: Procedure
metadata: {name: rename-note}
spec:
  input: {type: object, additionalProperties: false, required: [id, title], properties: {id: {type: string}, title: {type: string}}}
  output: {type: object}
  handler: {sql: 'UPDATE notes SET title = input.title WHERE id = input.id RETURNING id'}
---
apiVersion: cms.mantle.aotter.net/v2
kind: Trigger
metadata: {name: add-note-http}
spec: {source: {kind: http, method: POST, path: /api/notes}, target: {procedure: add-note}}
---
apiVersion: cms.mantle.aotter.net/v2
kind: Trigger
metadata: {name: rename-note-http}
spec: {source: {kind: http, method: PUT, path: '/api/notes/{id}'}, target: {procedure: rename-note}}
---
apiVersion: cms.mantle.aotter.net/v2
kind: Trigger
metadata: {name: add-note-mcp}
spec: {source: {kind: mcp, surface: public}, target: {procedure: add-note}}
---
apiVersion: cms.mantle.aotter.net/v2
kind: Trigger
metadata: {name: rename-note-mcp}
spec: {source: {kind: mcp, surface: public}, target: {procedure: rename-note}}
`;
const astral = "😀😀😀", // 3 code points, 12 UTF-8 bytes: exactly the byte limit
  multiByte = "é".repeat(7), // 7 code points (under maxLength 10), 14 UTF-8 bytes (over 12)
  nul = "a\u0000b",
  lone = "a\uD800b";
const failures = [
  [{ title: multiByte }, "/title", "Value violates x-mantle-maxBytes."],
  [{ title: nul }, "/title", "Expected text without NUL or an unpaired surrogate."],
  [{ title: lone }, "/title", "Expected text without NUL or an unpaired surrogate."],
  [{ title: "ok", tags: ["fine", nul] }, "/tags/1", "Expected text without NUL or an unpaired surrogate."],
] as const;

test("the generated validator refuses NUL, a lone surrogate and a value over x-mantle-maxBytes at its path", async () => {
  const files = await generateOrThrow("bun-sqlite", [{ sourceId: "text.yaml", text: source }]);
  const dir = await mkdtemp(join(tmpdir(), "mantle-text-"));
  try {
    await writeGenerated(dir, files);
    const { validate } = await import(join(dir, "validation/procedures/add-note.ts"));
    expect(validate({ title: astral, tags: [astral] })).toEqual({ title: astral, tags: [astral] });
    for (const [input, at, message] of failures)
      expect(() => validate(input)).toThrow(
        expect.objectContaining({ code: "INPUT_VALIDATION_FAILED", path: `procedures/add-note/input${at}`, message }),
      );
    // the View's query-string reader decodes %00 to NUL and validates it like a body
    const { query } = await import(join(dir, "validation/views/notes.ts"));
    expect(query(new URLSearchParams("title=" + encodeURIComponent(astral))).input).toEqual({ title: astral });
    expect(() => query(new URLSearchParams("title=a%00b"))).toThrow(
      expect.objectContaining({ code: "INPUT_VALIDATION_FAILED", path: "views/notes/input/title" }),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("REST and MCP refuse the same strings with INPUT_VALIDATION_FAILED and accept a valid astral value", async () => {
  const files = await generateOrThrow("bun-sqlite", [{ sourceId: "text.yaml", text: source }]);
  const dir = await mkdtemp(resolve(import.meta.dir, ".text-")),
    db = new Database(":memory:");
  const caller = fixtureCaller({
    kind: "user",
    subject: "u",
    role: "admin",
    admin: true,
    scopes: ["mcp"],
    credential: "oauth",
    credentialId: null,
    clientId: null,
  });
  try {
    await writeGenerated(dir, files);
    db.exec(files["schema.sql"]!);
    const { rest } = await import(join(dir, "rest.ts")),
      { mcp } = await import(join(dir, "mcp.ts"));
    const api = rest({ db: () => db, caller: async () => caller }),
      tools = mcp({ db: () => db, caller: () => caller });
    const post = (path: string, body: unknown, method = "POST") =>
      api(
        new Request("https://app.test" + path, {
          method,
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
        {},
      );
    const call = async (name: string, args: unknown) => {
      const response = await tools(
        new Request("https://app.test/mcp", {
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
        }),
        {},
      );
      const text = await response.text();
      return JSON.parse(text.startsWith("event:") ? text.split("data: ")[1]!.split("\n")[0]! : text).result;
    };
    for (const [input, at, message] of failures) {
      const response = await post("/api/notes", input);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        error: { code: "INPUT_VALIDATION_FAILED", path: `procedures/add-note/input${at}`, message },
      });
      const result = await call("add_note", input);
      expect(result.isError).toBe(true);
      expect(JSON.parse(result.content[0].text).diagnostics[0]).toMatchObject({
        code: "INPUT_VALIDATION_FAILED",
        path: `procedures/add-note/input${at}`,
        message,
      });
    }
    expect((await post("/api/notes", { title: astral })).status).toBe(200);
    expect((await call("add_note", { title: astral })).isError).toBeFalsy();
    expect(db.query("SELECT title FROM notes").all()).toEqual([{ title: astral }, { title: astral }]);
    // a path parameter is decoded into the same input and validated with it
    const path = await post("/api/notes/a%00b", { title: "x" }, "PUT");
    expect(path.status).toBe(400);
    expect(await path.json()).toMatchObject({
      error: { code: "INPUT_VALIDATION_FAILED", path: "procedures/rename-note/input/id" },
    });
    // the View reads its query string and MCP arguments through the same check
    const view = await api(new Request("https://app.test/api/views/notes?title=a%00b"), {});
    expect(view.status).toBe(400);
    expect(await view.json()).toMatchObject({
      error: { code: "INPUT_VALIDATION_FAILED", path: "views/notes/input/title" },
    });
    const listed = await call("notes", { title: lone });
    expect(listed.isError).toBe(true);
    expect(JSON.parse(listed.content[0].text).diagnostics[0]).toMatchObject({
      code: "INPUT_VALIDATION_FAILED",
      path: "views/notes/input/title",
    });
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
