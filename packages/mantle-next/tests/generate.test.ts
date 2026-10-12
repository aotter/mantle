import type { LoweredStatement } from "@aotter/mantle/spec";
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { compilePlan, NATIVE_NOT_NULL, notNullColumns, viewOutputs } from "@aotter/mantle/spec";
import * as postgresCompile from "@aotter/mantle/postgres/compile";
import { initialStorageSql as sqliteSchema } from "../../mantle/dist/d1/storage.js";
import { initialStorageSql as postgresSchema } from "../../mantle/dist/postgres/storage.js";
import { coreNewId, generateFromSources } from "../src/infrastructure/generate.js";
import { generate } from "../src/usecase/generate.js";
import type { Target } from "../src/domain/model.js";
import { user } from "./apps/fixtures.js";
import { loadGenerated } from "./apps/link.js";

const source = `apiVersion: cms.mantle.aotter.net/v2
kind: Schema
metadata: {name: notes}
spec:
  title: Notes
  lifecycle: operational
  scope: {owner: auth.uid()}
  indexes: [[owner]]
  schema:
    type: object
    required: [owner, title]
    properties: {owner: {type: string}, title: {type: string}}
---
apiVersion: cms.mantle.aotter.net/v2
kind: View
metadata: {name: notes-list}
spec:
  surface: internal
  sql: SELECT id, title FROM notes ORDER BY title, id
---
apiVersion: cms.mantle.aotter.net/v2
kind: Procedure
metadata: {name: create-note}
spec:
  requires: {auth: {all: [ctx.user]}}
  input: {type: object, required: [title], properties: {title: {type: string}}, additionalProperties: false}
  output: {type: object, required: [results], properties: {results: {type: array}}}
  handler: {sql: 'INSERT INTO notes (title) VALUES (input.title) RETURNING id, title'}
---
apiVersion: cms.mantle.aotter.net/v2
kind: Procedure
metadata: {name: update-note}
spec:
  requires: {auth: {all: [ctx.user]}}
  input: {type: object, required: [id, title, version], properties: {id: {type: string}, title: {type: string}, version: {type: integer}}}
  output: {type: object, required: [results], properties: {results: {type: array}}}
  handler: {sql: 'UPDATE notes SET title = input.title WHERE id = input.id AND version = input.version RETURNING id, title'}
---
apiVersion: cms.mantle.aotter.net/v2
kind: Procedure
metadata: {name: create-note-pair}
spec:
  requires: {auth: {all: [ctx.user]}}
  input: {type: object, required: [title], properties: {title: {type: string}}, additionalProperties: false}
  output: {type: object, required: [results], properties: {results: {type: array}}}
  handler: {sql: 'INSERT INTO notes (title) VALUES (input.title); INSERT INTO notes (title) VALUES (input.title) RETURNING id'}
`;
async function canonical(target: Target, text = source) {
  const sqlite = target === "bun-sqlite" || target === "cloudflare-d1";
  const { lowerPlan } = await import(new URL("../../mantle/src/core/sql/lowered.ts", import.meta.url).href);
  const dialectModule = await import(new URL(sqlite ? "../../mantle/src/d1/dialect.ts" : "../../mantle/src/postgres/dialect.ts", import.meta.url).href);
  const dialect = sqlite ? dialectModule.d1Dialect : dialectModule.postgresDialect();
  const compiled = await compilePlan({ sources: [{ sourceId: "notes.yaml", text }] }, sqlite ? undefined : postgresCompile);
  if (!compiled.ok) throw Error(JSON.stringify(compiled.diagnostics));
  const { lowered } = lowerPlan(compiled.plan, dialect);
  return { target, plan: compiled.plan, lowered, newId: coreNewId(dialect, compiled.plan.schemas), viewKeys: Object.fromEntries(Object.entries(compiled.plan.views).map(([name, view]) => [name, viewOutputs(view, compiled.plan.schemas).keys])) };
}
describe("native generation", () => {
  for (const target of ["bun-sqlite", "bun-postgres", "cloudflare-d1", "cloudflare-postgres"] as const) test(target, async () => {
    const input = await canonical(target);
    const generated = generate(input);
    if (!generated.ok) throw Error(JSON.stringify(generated.diagnostics));
    const text = generated.files["generated.ts"]!;
    expect(text).toContain('["notes-list"]: view0');
    expect(text).toContain('["create-note"]: procedure0');
    for (const mode of ["caller", "trusted"] as const) expect(text).toContain(JSON.stringify(input.lowered.views["notes-list"]![mode]!.sql));
    const driver = target === "bun-sqlite" ? "driver/bun-sqlite" : target === "cloudflare-d1" ? "driver/d1" : "driver/postgres";
    expect(text).toContain(`import * as DRIVER from "@aotter/mantle-next/${driver}"`);
    expect(generate(input)).toEqual(generated);
  });
  test("unsupported programs fail generation with paths rather than omitting behavior", async () => {
    const input = await canonical("bun-sqlite");
    const unsupported = { ...input, plan: { ...input.plan, procedures: { ...input.plan.procedures, handler: { ...input.plan.procedures["create-note"]!, handler: { ref: "app-handler" } } }, triggers: { after: { source: { kind: "lifecycle", schema: "notes", on: ["after_create"] }, procedure: "handler" } } } };
    const result = generate(unsupported as never);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.diagnostics.map(d => d.path)).toEqual(expect.arrayContaining(["triggers/after"]));
    const mismatch = generate({ ...input, target: "bun-postgres" });
    expect(mismatch.ok).toBe(false);
  });
});

test("a lifecycle declaration refuses generation even when only trusted SQL is marked hooked", async () => {
  const input = await canonical("bun-sqlite");
  const modes = input.lowered.procedures["create-note"]!;
  const hooked = { ...input, plan: { ...input.plan, triggers: { after: { source: { kind: "lifecycle" as const, schema: "notes", on: ["after_create" as const] }, procedure: "create-note" } } }, lowered: { ...input.lowered, procedures: { ...input.lowered.procedures, "create-note": { ...modes, trusted: modes.trusted.map((s: LoweredStatement) => ({ ...s, hooked: true as const })) } } } };
  const result = generate(hooked);
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.diagnostics).toEqual([{ code: "GENERATE_UNSUPPORTED", path: "triggers/after", message: "Before/after lifecycle hooks are unsupported. Write a custom handler." }]);
});

test("bare PG writes on the Bun.SQL shape read a unique clash as CONFLICT and signal uncertain outcomes", async () => {
  const generated = generate(await canonical("bun-postgres"));
  if (!generated.ok) throw Error(JSON.stringify(generated.diagnostics));
  const caller = user("test-user");
  // Bun.SQL reports SQLSTATE in errno; node-postgres/postgres.js in code.
  const server = (state: string, bun = false) => Object.assign(new Error("native-" + state), bun ? { errno: state, code: "ERR_POSTGRES_SERVER_ERROR", severity: "ERROR" } : { code: state, severity: "ERROR" });
  const socket = () => Object.assign(new Error("native-socket"), { code: "ERR_POSTGRES_CONNECTION_CLOSED" });
  {
    const module = await loadGenerated(generated.files["generated.ts"]!);
    // One statement, autocommit: no begin(), one round trip.
    for (const [failure, expected] of [["none", undefined], ["zero", "CONFLICT"], ["23505", "CONFLICT"], ["23505-bun", "CONFLICT"], ["57014", "OUTCOME_UNKNOWN"], ["socket", "OUTCOME_UNKNOWN"]] as const) {
      const error = failure === "socket" ? socket() : failure.startsWith("2") || failure.startsWith("5") ? server(failure.slice(0, 5), failure.endsWith("bun")) : undefined;
      const calls: string[] = [];
      const db = { unsafe: async (text: string) => { calls.push(text); if (error) throw error; return Object.assign([], { count: failure === "zero" ? 0 : 1 }); }, begin: async () => { calls.push("BEGIN"); throw Error("unexpected begin"); } };
      let caught: any;
      try { await module.procedures["update-note"](db, caller, { id: "n1", title: "t", version: 1 }); } catch (e) { caught = e; }
      expect(calls.length).toBe(1); expect(calls[0]).toStartWith("UPDATE");
      if (expected === undefined) expect(caught).toBeUndefined();
      else { expect(caught.code).toBe(expected); if (error) expect(caught.cause).toBe(error); }
    }
    // Two statements: begin() owns the connection and ROLLBACK; only a failed COMMIT is uncertain.
    for (const [failure, expected] of [["execute", "CONFLICT"], ["commit-40001", "native"], ["commit-57P01", "OUTCOME_UNKNOWN"], ["commit-socket", "OUTCOME_UNKNOWN"]] as const) {
      for (const operation of ["procedure", "batch", "transaction"] as const) {
        const error = failure === "execute" ? server("23505") : failure === "commit-socket" ? socket() : server(failure.slice(7));
        const calls: string[] = [];
        const tx = { unsafe: async (text: string) => { calls.push(text); if (failure === "execute") throw error; return Object.assign([], { count: 1 }); } };
        const db = { unsafe: async () => { throw Error("statements must run inside begin()"); }, begin: async (options: string, fn: (t: unknown) => Promise<unknown>) => {
          calls.push("BEGIN " + options);
          try { await fn(tx); } catch (e) { calls.push("ROLLBACK"); throw e; }
          calls.push("COMMIT"); throw error;
        } };
        let caught: any;
        try {
          if (operation === "procedure") await module.procedures["create-note-pair"](db, caller, { title: "t" });
          else {
            const store = module.store(db, caller);
            if (operation === "batch") await store.batch([store.collection("notes").insert({ title: "one" }), store.collection("notes").insert({ title: "two" })]);
            else await store.transaction(async (tx: any) => tx.procedures["create-note-pair"]({ title: "t" }));
          }
        } catch (e) { caught = e; }
        expect(calls[0]).toBe("BEGIN isolation level serializable");
        if (expected === "native") expect(caught).toBe(error); else { expect(caught.code).toBe(expected); expect(caught.cause).toBe(error); }
        expect(calls.at(-1)).toBe(failure === "execute" ? "ROLLBACK" : "COMMIT");
      }
    }
  }
});

test("repeated or unverified View outputs explicitly refuse generation", async () => {
  const input = await canonical("bun-postgres");
  for (const keys of [undefined, ["id", "id", "title"]]) {
    const result = generate({...input, viewKeys: {"notes-list": keys}});
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.diagnostics.some(d => d.path === "views/notes-list")).toBe(true);
  }
});

test("PG declared integer output types include native unsafe-int8 strings", async () => {
  const integerSource = source.replace('title: {type: string}}', 'title: {type: string}, total: {type: integer}}').replace('SELECT id, title FROM notes', 'SELECT id, title, total FROM notes');
  for (const target of ["bun-postgres", "bun-sqlite"] as const) {
    const generated = generate(await canonical(target, integerSource));
    if (!generated.ok) throw Error(JSON.stringify(generated.diagnostics));
    expect(generated.files["generated.ts"]).toContain(`readonly "total": ${target === "bun-postgres" ? "number | string" : "number"} | null;`);
  }
});

test("native binds directly use authored input names", async () => {
  const text = source.replace('input: {type: object, required: [title], properties: {title: {type: string}}, additionalProperties: false}', 'input: {type: object, properties: {NoteTitle: {type: string, nullable: true}}, additionalProperties: false}').replace('VALUES (input.title)', "VALUES (coalesce(input.noteTitle, input.noteTitle, ''Nullable fallback''))");
  const generated = await generateFromSources({target:"bun-sqlite",sources:{sources:[{sourceId:"names.yaml",text}]}});
  if (!generated.ok) throw Error(JSON.stringify(generated.diagnostics));
  const db = new Database(":memory:");
  const caller = user("test-owner");
  try {
    db.exec(generated.files["schema.sql"]!);
    const app = await loadGenerated(generated.files["generated.ts"]!);
    await app.procedures["create-note"](db,caller,{NoteTitle:"Authored case"});
    await app.procedures["create-note"](db,caller,{NoteTitle:null});
    expect(db.query("SELECT title FROM notes ORDER BY title").all()).toEqual([{title:"Authored case"},{title:"Nullable fallback"}]);
  } finally { db.close(); }
  const original = await canonical("bun-sqlite");
  const ambiguous = generate({...original,plan:{...original.plan,procedures:{...original.plan.procedures,"create-note":{...original.plan.procedures["create-note"]!,input:{type:"object",properties:{Title:{type:"string"},title:{type:"string"}}}}}}});
  expect(ambiguous.ok).toBe(false);
  if (!ambiguous.ok) expect(ambiguous.diagnostics.some(d=>d.path==="procedures/create-note/input" && d.message.includes("case-insensitive"))).toBe(true);
});

for (const target of ["bun-sqlite", "bun-postgres", "cloudflare-d1", "cloudflare-postgres"] as const) test(`${target} bare View preserves driver rows and errors without validation`, async () => {
  const generated = generate(await canonical(target));
  if (!generated.ok) throw Error(JSON.stringify(generated.diagnostics));
  const rows = [{id:"native-id",title:null}];
  const caller = user("test-user");
  let failure: unknown;
  let calls = 0;
  const execute = () => { calls++; if (failure) throw failure; return rows; };
  const db = target === "bun-sqlite" ? {query:()=>({all:execute})}
    : target === "cloudflare-d1" ? {prepare:()=>({bind:()=>({all:async()=>({results:execute()})})})}
    : {unsafe:async()=>execute()};
  {
    const app = await loadGenerated(generated.files["generated.ts"]!);
    // A cyclic extra value proves no recursive scan or schema parse runs here.
    const input:any = {}; input.extra = input;
    expect(await app.views["notes-list"](db,caller,input)).toBe(rows);
    expect(calls).toBe(1);
    failure = new Error("native failure identity");
    await expect(app.views["notes-list"](db,caller,{})).rejects.toBe(failure);
    expect(calls).toBe(2);
  }
});

test("SQLite native bound fields retain nullable unions and require explicit values", async () => {
  const input = await canonical("cloudflare-d1");
  const procedure = {...input.plan.procedures["create-note"]!,input:{type:"object" as const,properties:{title:{type:["boolean","null"] as ("boolean"|"null")[]}}}};
  const lower = {...input.lowered,procedures:{...input.lowered.procedures,"create-note":Object.fromEntries((["caller","trusted"] as const).map(mode=>[mode,input.lowered.procedures["create-note"]![mode]!.map((statement:LoweredStatement)=>({...statement,binds:statement.binds.map(bind=>bind.k === "input" ? {...bind,type:"bool"} : bind)}))]))}};
  const result = generate({...input,plan:{...input.plan,procedures:{"create-note":procedure}},lowered:lower});
  if (!result.ok) throw Error(JSON.stringify(result.diagnostics));
  expect(result.files["generated.ts"]).toContain('readonly "title": number | null;');
  expect(result.files["generated.ts"]).not.toContain('readonly "title"?:');
});

const scalars = `apiVersion: cms.mantle.aotter.net/v2
kind: Schema
metadata: {name: events}
spec:
  title: Events
  lifecycle: operational
  scope: {owner: auth.uid()}
  indexes: [[owner]]
  schema:
    type: object
    required: [owner, at, day]
    properties: {owner: {type: string}, at: {type: string, format: date-time}, day: {type: string, format: date}}
---
apiVersion: cms.mantle.aotter.net/v2
kind: View
metadata: {name: events-list}
spec:
  surface: internal
  sql: SELECT e.at, e.day, e.created_at FROM events e ORDER BY at
---
apiVersion: cms.mantle.aotter.net/v2
kind: View
metadata: {name: events-span}
spec:
  surface: internal
  sql: SELECT count(e.at) AS n, max(e.at) AS latest, min(e.day) AS first FROM events e
`;

test("declared timestamps and dates come back in wire form from the SQL itself", async () => {
  const generated = await generateFromSources({target:"bun-sqlite",sources:{sources:[{sourceId:"events.yaml",text:scalars}]}});
  if (!generated.ok) throw Error(JSON.stringify(generated.diagnostics));
  expect(generated.files["generated.ts"]).toContain('readonly "at": string | null; readonly "day": string | null; readonly "created_at": string | null;');
  const db = new Database(":memory:");
  try {
    db.exec(generated.files["schema.sql"]!);
    // Storage as Mantle writes it: microseconds and days. Before 1970 is negative.
    db.query("INSERT INTO events (id, version, created_at, updated_at, owner, at, day) VALUES ('a', 1, 0, 0, 'u', ?, ?)").run(1791676800123456, 20738);
    db.query("INSERT INTO events (id, version, created_at, updated_at, owner, at, day) VALUES ('b', 1, 0, 0, 'u', ?, ?)").run(-1, -1);
    const app = await loadGenerated(generated.files["generated.ts"]!);
    const caller = user("u");
    // Only min/max keep the column's type; count is an integer and stays one.
    expect(await app.views["events-span"](db,caller,{})).toEqual([{n:2,latest:"2026-10-11T00:00:00.123456Z",first:"1969-12-31"}]);
    expect(await app.views["events-list"](db,caller,{})).toEqual([
      {at:"1969-12-31T23:59:59.999999Z",day:"1969-12-31",created_at:"1970-01-01T00:00:00.000000Z"},
      {at:"2026-10-11T00:00:00.123456Z",day:"2026-10-12",created_at:"1970-01-01T00:00:00.000000Z"},
    ]);
  } finally { db.close(); }
  for (const target of ["bun-postgres", "cloudflare-postgres"] as const) {
    const pg = await generateFromSources({target,sources:{sources:[{sourceId:"events.yaml",text:scalars}]}});
    if (!pg.ok) throw Error(JSON.stringify(pg.diagnostics));
    expect(pg.files["generated.ts"]).toContain(`to_char((e.at) AT TIME ZONE 'UTC', 'YYYY-MM-DD\\"T\\"HH24:MI:SS.US\\"Z\\"')`);
  }
});

test("the Store's rules are Core's, emitted once; a Schema adds only a small fact", async () => {
  for (const target of ["bun-sqlite", "bun-postgres"] as const) {
    const generated = await generateFromSources({ target, sources: { sources: [{ sourceId: "notes.yaml", text: source }] } });
    if (!generated.ok) throw Error(JSON.stringify(generated.diagnostics));
    const text = generated.files["generated.ts"]!, store = text.slice(text.indexOf("const RULES"));
    expect(store).toContain(`"notes": {"s":"owner"}`);
    expect(store).not.toMatch(/SELECT|FROM|CASE WHEN/);
    expect(Object.keys(generated.files).filter(name => name.startsWith("stores/"))).toEqual([]);
  }
});
test("the NOT NULL columns the generated types assume are the ones the initial storage SQL declares", async () => {
  const columns = (ddl: string) => { // the NOT NULL column names of one CREATE TABLE
    const body = ddl.slice(ddl.indexOf("(") + 1, ddl.lastIndexOf(")"));
    return body.split(/,\s(?![^(]*\))/).filter(c => /\bNOT NULL\b/.test(c)).map(c => /^"?(\w+)"?/.exec(c.trim())![1]!);
  };
  for (const [target, storage] of [["bun-sqlite", sqliteSchema], ["bun-postgres", postgresSchema]] as const) {
    const { plan } = await canonical(target);
    const notes = plan.schemas.notes!, ddl = storage(plan.schemas).find(sql => sql.includes(`"notes"`) && /CREATE TABLE/.test(sql))!;
    // not `status` (publishing only) nor `_rid`; the scope column is native text
    expect(new Set(columns(ddl))).toEqual(new Set([...[...NATIVE_NOT_NULL].filter(c => c !== "status"), notes.scope!, ...notNullColumns(notes)]));
  }
});
test("generation is refused when a Schema's rules would not be Core's", async () => {
  const { emitStores } = await import("../src/usecase/stores.js");
  const schema = { name: "t", fields: { c: "timestamptz" }, names: {}, schema: { type: "object" }, scope: "owner", ttl: "c" };
  const refused: string[] = [];
  expect(emitStores({ t: schema as never }, true, "x", (_, message) => refused.push(message))).toBeDefined();
  expect(refused.length).toBe(1); expect(refused[0]).toContain("differ from the shared rules"); // ttlSeconds is absent: Core's term has no seconds
  const fine: string[] = [];
  emitStores({ t: { ...schema, ttlSeconds: 60 } as never }, true, "x", (_, message) => fine.push(message));
  expect(fine).toEqual([]);
});

test("canonical UTC DDL supplies timezone offsets used by generated date SQL", async () => {
  const utcDay = `apiVersion: cms.mantle.aotter.net/v2
kind: View
metadata: {name: utc-day}
spec:
  surface: public
  sql: |
    SELECT date_trunc('day', CAST('2026-10-11T12:34:56.123456Z' AS timestamptz)) AS day
`;
  const generated = await generateFromSources({target:"bun-sqlite",sources:{sources:[{sourceId:"utc.yaml",text:utcDay}]}});
  if (!generated.ok) throw Error(JSON.stringify(generated.diagnostics));
  expect(generated.files["schema.sql"]).toContain("CREATE TABLE IF NOT EXISTS _mantle_tz");
  expect(generated.files["schema.sql"]).toContain("(-9007199254740991, 0)");
  expect(generated.files["generated.ts"]).toContain("_mantle_tz");
  const db = new Database(":memory:");
  try {
    db.exec(generated.files["schema.sql"]!);
    db.exec(generated.files["schema.sql"]!); // re-applying the initial artifact is harmless
    const app = await loadGenerated(generated.files["generated.ts"]!);
    expect(await app.views["utc-day"](db,{kind:"anonymous"},{})).toEqual([{day:Date.parse("2026-10-11T00:00:00Z")*1000}]);
  } finally { db.close(); }
});
