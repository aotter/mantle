import type { LoweredStatement } from "@aotter/mantle/spec";
import { describe, expect, test } from "bun:test";
import { writeFile, unlink } from "node:fs/promises";
import { z } from "zod";
import { emitValidator } from "../src/domain/validation.js";
import { generateFromSources } from "../src/infrastructure/generate.js";
import { Database } from "bun:sqlite";
import { compilePlan, viewOutputs } from "@aotter/mantle/spec";
import * as postgresCompile from "@aotter/mantle/postgres/compile";
import { generate } from "../src/usecase/generate.js";
import type { Target } from "../src/domain/model.js";

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
  return { target, checked:true, plan: compiled.plan, lowered, viewKeys: Object.fromEntries(Object.entries(compiled.plan.views).map(([name, view]) => [name, viewOutputs(view, compiled.plan.schemas).keys])) };
}
describe("native generation", () => {
  for (const target of ["bun-sqlite", "bun-postgres", "cloudflare-d1", "cloudflare-postgres"] as const) test(target, async () => {
    const input = await canonical(target);
    const generated = generate(input);
    if (!generated.ok) throw Error(JSON.stringify(generated.diagnostics));
    const text = generated.files["checked.ts"]!;
    expect(text).toContain('["notes-list"]: view0');
    expect(text).toContain('["create-note"]: procedure0');
    expect(text).toContain("caller.subject");
    expect(text).not.toContain("RuntimePlan");
    expect(text).not.toContain("runView");
    expect(text).not.toContain("runProcedure");
    expect(text).not.toContain("jsonSchemaToZod");
    expect(text).toContain("??= z.object");
    for (const mode of ["caller", "trusted"] as const) expect(text).toContain(JSON.stringify(input.lowered.views["notes-list"]![mode]!.sql));
    if (target === "bun-sqlite") { expect(text).toContain("db.transaction(execute)()"); expect(text).toContain("results = execute()"); expect(text).toContain(".length !== 1"); expect(text).not.toContain("SELECT changes()"); }
    else if (target === "cloudflare-d1") { expect(text).toContain("db.batch(["); expect(text).toContain("INSERT INTO _mantle_assert (op,ok)"); expect(text).toContain("changes() = 1"); }
    else { expect(text).toContain("BEGIN ISOLATION LEVEL SERIALIZABLE"); expect(text).toContain('db.query("ROLLBACK")'); expect(text).toContain(".rowCount !== 1"); expect(text.match(/BEGIN ISOLATION/g)!.length).toBe(1); }
    expect(generate(input)).toEqual(generated);
  });
  test("unsupported programs fail generation with paths rather than omitting behavior", async () => {
    const input = await canonical("bun-sqlite");
    const unsupported = { ...input, plan: { ...input.plan, procedures: { ...input.plan.procedures, handler: { ...input.plan.procedures["create-note"]!, handler: { ref: "app-handler" } } }, triggers: { after: { source: { schema: "notes", event: "after_create" }, procedure: "handler" } } } };
    const result = generate(unsupported as never);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.diagnostics.map(d => d.path)).toEqual(expect.arrayContaining(["triggers/after", "procedures/handler"]));
    const mismatch = generate({ ...input, target: "bun-postgres" });
    expect(mismatch.ok).toBe(false);
  });
});

test("generated string length refusal aborts before pattern execution", () => {
  const expression = emitValidator({ type: "string", maxLength: 3, pattern: "x" })!;
  const schema = new Function("z", `return ${expression}`)(z);
  let calls = 0;
  const original = RegExp.prototype.test;
  RegExp.prototype.test = function(text) { if (this.source === "x") calls++; return original.call(this, text); };
  try { expect(schema.safeParse("too long").success).toBe(false); expect(calls).toBe(0); }
  finally { RegExp.prototype.test = original; }
});

for (const checked of [false,true]) test(`${checked ? "checked" : "bare"} PG transactions preserve failures and signal uncertain ownership`, async () => {
  const generated = generate(await canonical("bun-postgres"));
  if (!generated.ok) throw Error(JSON.stringify(generated.diagnostics));
  const path = new URL(`.generated-${crypto.randomUUID()}.ts`, import.meta.url);
  await writeFile(path, generated.files[checked ? "checked.ts" : "generated.ts"]!.replaceAll('"@aotter/mantle-next/contracts"', '"../src/kernel/contracts.ts"'));
  const caller = { kind: "user", subject: "test-user", role: null, scopes: [], credential: "session", credentialId: null, clientId: null };
  try {
    const module = await import(path.href);
    for (const failure of ["begin", "execute", "rollback", "commit", "commit-known", "commit-shutdown"] as const) {
      const original = Object.assign(new Error(`native-${failure}`), failure === "commit-known" ? {code:"40001"} : failure === "commit-shutdown" ? {code:"57P01"} : {}), rollback = new Error("native-rollback");
      const calls: string[] = [];
      const db = { query: async (query: string | {text: string}) => {
        const sql = typeof query === "string" ? query : query.text;
        calls.push(sql);
        if (sql === "ROLLBACK") { if (failure === "rollback") throw rollback; return {}; }
        if (sql === "COMMIT") { if (failure.startsWith("commit")) throw original; return {}; }
        if (sql.startsWith("BEGIN")) { if (failure === "begin") throw original; return {}; }
        if (!failure.startsWith("commit")) throw original;
        return { rows: [], fields: [], rowCount: 1 };
      } };
      let caught: any;
      try { await module.procedures["create-note-pair"](db, caller, { title: "test" }); } catch (error) { caught = error; }
      if (!checked && ["begin","execute","commit-known"].includes(failure)) { expect(caught).toBe(original); if(failure !== "begin") expect(calls.at(-1)).toBe("ROLLBACK"); }
      else if (failure === "begin") { expect(caught.code).toBe("RESOURCE_UNAVAILABLE"); expect(caught.cause).toBe(original); expect(calls.length).toBe(1); }
      else if (failure === "execute") { expect(caught.code).toBe("RESOURCE_UNAVAILABLE"); expect(caught.cause).toBe(original); expect(caught.message).not.toContain("native-execute"); expect(calls.at(-1)).toBe("ROLLBACK"); }
      else if (failure === "rollback") { expect(caught.code).toBe("OUTCOME_UNKNOWN"); expect(caught.cause.errors).toEqual([original, rollback]); }
      else if (failure === "commit-known") { expect(caught.code).toBe("RESOURCE_UNAVAILABLE"); expect(caught.cause).toBe(original); expect(calls.at(-1)).toBe("ROLLBACK"); expect(calls.filter(sql => sql.startsWith("BEGIN")).length).toBe(1); }
      else { expect(caught.code).toBe("OUTCOME_UNKNOWN"); expect(caught.cause).toBe(original); expect(calls.at(-1)).toBe("ROLLBACK"); expect(calls.filter(sql => sql === "ROLLBACK").length).toBe(1); }
    }
  } finally { await unlink(path); }
});

for (const checked of [false,true]) test(`${checked ? "checked" : "bare"} single-statement PG writes autocommit and signal uncertain ownership`, async () => {
  const generated = generate(await canonical("bun-postgres"));
  if (!generated.ok) throw Error(JSON.stringify(generated.diagnostics));
  const path = new URL(`.generated-${crypto.randomUUID()}.ts`, import.meta.url);
  await writeFile(path, generated.files[checked ? "checked.ts" : "generated.ts"]!.replaceAll('"@aotter/mantle-next/contracts"', '"../src/kernel/contracts.ts"'));
  const caller = { kind: "user", subject: "test-user", role: null, scopes: [], credential: "session", credentialId: null, clientId: null };
  try {
    const module = await import(path.href);
    for (const failure of ["none", "zero-rows", "server", "timeout", "socket"] as const) {
      const original = Object.assign(new Error(`native-${failure}`), failure === "server" ? { code: "23505", severity: "ERROR" } : failure === "timeout" ? { code: "57014", severity: "ERROR" } : failure === "socket" ? { code: "EPIPE" } : {});
      const calls: string[] = [];
      const db = { query: async (query: string | {text: string}) => {
        calls.push(typeof query === "string" ? query : query.text);
        if (["server", "timeout", "socket"].includes(failure)) throw original;
        return { rows: [], fields: [], rowCount: failure === "zero-rows" ? 0 : 1 };
      } };
      let caught: any;
      try { await module.procedures["update-note"](db, caller, { id: "n1", title: "t", version: 1 }); } catch (error) { caught = error; }
      expect(calls.length).toBe(1);
      if (failure === "none") expect(caught).toBeUndefined();
      else if (failure === "zero-rows") expect(caught.code).toBe("CONFLICT");
      else if (failure === "socket") { expect(caught.code).toBe("OUTCOME_UNKNOWN"); expect(caught.cause).toBe(original); }
      else if (!checked) expect(caught).toBe(original);
      else expect(caught.code).toBe(failure === "server" ? "CONFLICT" : "OUTCOME_UNKNOWN");
    }
  } finally { await unlink(path); }
});

test("repeated or unverified View outputs explicitly refuse generation", async () => {
  const input = await canonical("bun-postgres");
  for (const keys of [undefined, ["id", "id", "title"]]) {
    const result = generate({...input, viewKeys: {"notes-list": keys}});
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.diagnostics.some(d => d.path === "views/notes-list")).toBe(true);
  }
});

test("distinct SQL outputs that collide after authored-name mapping refuse generation", async () => {
  const collision = `apiVersion: cms.mantle.aotter.net/v2
kind: Schema
metadata: {name: notes}
spec:
  title: Notes
  lifecycle: operational
  scope: {owner: auth.uid()}
  indexes: [[owner]]
  schema:
    type: object
    required: [owner]
    properties: {owner: {type: string}, titleText: {type: string}}
---
apiVersion: cms.mantle.aotter.net/v2
kind: View
metadata: {name: renamed-outputs}
spec:
  surface: internal
  sql: 'SELECT titletext, titletext AS "titleText" FROM notes'
`;
  for (const target of ["bun-sqlite", "bun-postgres", "cloudflare-d1", "cloudflare-postgres"] as const) {
    const input = await canonical(target, collision);
    expect(input.viewKeys["renamed-outputs"]).toEqual(["titletext", "titleText"]);
    const result = generate(input);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.diagnostics).toContainEqual({
      code: "GENERATE_UNSUPPORTED", path: "views/renamed-outputs",
      message: "Projected View output 'titleText' repeats after authored-name mapping.",
    });
    const distinct = collision.replace('titletext, titletext AS "titleText"', 'titletext, titletext AS "otherTitle"');
    expect(generate(await canonical(target, distinct)).ok).toBe(true);
  }
});

test("PG declared integer output types include native unsafe-int8 strings", async () => {
  const integerSource = source.replace('title: {type: string}}', 'title: {type: string}, total: {type: integer}}').replace('SELECT id, title FROM notes', 'SELECT id, title, total FROM notes');
  for (const target of ["bun-postgres", "bun-sqlite"] as const) {
    const generated = generate(await canonical(target, integerSource));
    if (!generated.ok) throw Error(JSON.stringify(generated.diagnostics));
    expect(generated.files["checked.ts"]).toContain(`readonly "total": ${target === "bun-postgres" ? "number | string" : "number"} | null;`);
  }
});

test("emission removes unused input locals and binds directly for SQLite hosts", async () => {
  for (const target of ["bun-sqlite", "cloudflare-d1", "bun-postgres", "cloudflare-postgres"] as const) {
    const generated = generate(await canonical(target));
    if (!generated.ok) throw Error(JSON.stringify(generated.diagnostics));
    const text = generated.files["checked.ts"]!;
    const view = text.slice(text.indexOf("async function view0"), text.indexOf("export type Procedure0Input"));
    expect(view).toContain("validate(view0Input");
    expect(view).not.toContain("const given");
    expect(view).not.toContain("const input");
    expect(view).not.toContain("let value");
    if (target === "bun-sqlite") { expect(view).toContain(".all(uid)"); expect(view).toContain(".all()"); }
    else if (target === "cloudflare-d1") { expect(view).toContain(".bind(uid)"); expect(view).toContain(".bind()"); }
    else expect(view).toContain("values: [uid]");
    expect(text).not.toContain("...[");
    // Procedures bind checked authored fields directly and retain scalar bind temporaries.
    expect(text).toContain("const given = validate(procedure0Input");
    expect(text).not.toContain("const input =");
    expect(text).toContain('value = given["title"]');
    expect(text).toContain("let value: any");
  }
});

test("PostgreSQL deployment requirements are explicit data without per-call SET", async () => {
  for (const target of ["bun-postgres", "cloudflare-postgres"] as const) {
    const generated = generate(await canonical(target));
    if (!generated.ok) throw Error(JSON.stringify(generated.diagnostics));
    const text = generated.files["checked.ts"]!;
    expect(text).toContain('export const postgresRequirements = { DateStyle: "ISO, YMD", IntervalStyle: "postgres", TimeZone: "UTC", standard_conforming_strings: "on", extra_float_digits: "1", statement_timeout: "10000ms" } as const;');
    expect(text).not.toContain('db.query("SET');
    expect(text).not.toContain("ALTER ROLE");
  }
});

test("row emission uses static keys, row-local decoder scratch and safe __proto__", async () => {
  const booleanSource = source.replaceAll('title: {type: string}', 'title: {type: boolean}');
  const generated = generate(await canonical("bun-sqlite", booleanSource));
  if (!generated.ok) throw Error(JSON.stringify(generated.diagnostics));
  const text = generated.files["checked.ts"]!;
  const view = text.slice(text.indexOf("async function view0"), text.indexOf("export type Procedure0Input"));
  expect(view).toContain('.map(row => { let value: any; return { "id":');
  expect(view).toContain('"title": (value = row["title"]');
  expect(view.slice(0,view.indexOf(".map(row"))).not.toContain("let value");
  expect(text.slice(text.indexOf("async function procedure0"))).toContain("let value: any");
  const dangerous = generate(await canonical("bun-sqlite", source.replace('SELECT id, title FROM notes', 'SELECT id, title AS "__proto__" FROM notes')));
  if (!dangerous.ok) throw Error(JSON.stringify(dangerous.diagnostics));
  expect(dangerous.files["checked.ts"]).toContain('["__proto__"]: row["__proto__"]');
  const file = new URL(`.generated-${crypto.randomUUID()}.ts`, import.meta.url);
  await writeFile(file,dangerous.files["checked.ts"]!.replaceAll('"@aotter/mantle-next/contracts"','"../src/kernel/contracts.ts"'));
  try {
    const app = await import(file.href);
    const row = Object.defineProperty({id:"test"},"__proto__",{value:{unsafe:true},enumerable:true});
    const [output] = await app.views["notes-list"]({query:()=>({all:()=>[row]})},{kind:"anonymous"},{});
    expect(Object.hasOwn(output,"__proto__")).toBe(true);
    expect(output.__proto__).toEqual({unsafe:true});
    expect(Object.getPrototypeOf(output)).toBe(Object.prototype);
  } finally { await unlink(file); }
});

test("native binds directly use authored input names and checked defaults", async () => {
  const text = source.replace('input: {type: object, required: [title], properties: {title: {type: string}}, additionalProperties: false}', 'input: {type: object, properties: {NoteTitle: {type: string, nullable: true, default: Generated default}}, additionalProperties: false}').replace('VALUES (input.title)', "VALUES (coalesce(input.noteTitle, input.noteTitle, ''Nullable fallback''))");
  const generated = await generateFromSources({checked:true,target:"bun-sqlite",sources:{sources:[{sourceId:"default.yaml",text}]}});
  if (!generated.ok) throw Error(JSON.stringify(generated.diagnostics));
  expect(generated.files["checked.ts"]).toContain('value = given["NoteTitle"]');
  expect(generated.files["checked.ts"]).not.toContain("const input =");
  const file = new URL(`.generated-${crypto.randomUUID()}.ts`,import.meta.url);
  await writeFile(file,generated.files["checked.ts"]!.replaceAll('"@aotter/mantle-next/contracts"','"../src/kernel/contracts.ts"'));
  const db = new Database(":memory:");
  const caller = {kind:"user",subject:"test-owner",role:null,scopes:[],credential:"session",credentialId:null,clientId:null};
  try {
    db.exec(generated.files["schema.sql"]!);
    const app = await import(file.href);
    await app.procedures["create-note"](db,caller,{});
    await app.procedures["create-note"](db,caller,{NoteTitle:"Authored case"});
    await app.procedures["create-note"](db,caller,{NoteTitle:null});
    expect(db.query("SELECT title FROM notes ORDER BY title").all()).toEqual([{title:"Authored case"},{title:"Generated default"},{title:"Nullable fallback"}]);
  } finally { db.close(); await unlink(file); }
  const original = await canonical("bun-sqlite");
  const ambiguous = generate({...original,plan:{...original.plan,procedures:{...original.plan.procedures,"create-note":{...original.plan.procedures["create-note"]!,input:{type:"object",properties:{Title:{type:"string"},title:{type:"string"}}}}}}});
  expect(ambiguous.ok).toBe(false);
  if (!ambiguous.ok) expect(ambiguous.diagnostics.some(d=>d.path==="procedures/create-note/input" && d.message.includes("case-insensitive"))).toBe(true);
});

for (const target of ["bun-sqlite", "bun-postgres", "cloudflare-d1", "cloudflare-postgres"] as const) test(`${target} bare View preserves driver rows and errors without validation`, async () => {
  const generated = generate({...await canonical(target), checked:false});
  if (!generated.ok) throw Error(JSON.stringify(generated.diagnostics));
  expect(generated.files["checked.ts"]).toBeUndefined();
  const code = generated.files["generated.ts"]!;
  expect(code).not.toMatch(/zod|validate\(|decodeField|encodeInteger|rawTypes|databaseError|\.map\(/);
  const file = new URL(`.bare-${crypto.randomUUID()}.ts`, import.meta.url);
  await writeFile(file,code.replaceAll('"@aotter/mantle-next/contracts"','"../src/kernel/contracts.ts"'));
  const rows = [{id:"native-id",title:null}];
  const caller = {kind:"user",subject:"test-user",role:null,scopes:[],credential:"session",credentialId:null,clientId:null};
  let failure: unknown;
  let calls = 0;
  const execute = () => { calls++; if (failure) throw failure; return rows; };
  const db = target === "bun-sqlite" ? {query:()=>({all:execute})}
    : target === "cloudflare-d1" ? {prepare:()=>({bind:()=>({all:async()=>({results:execute()})})})}
    : {query:async(query:any)=>{expect(query.types).toBeUndefined();return {rows:execute()};}};
  try {
    const app = await import(file.href);
    // A cyclic extra value proves no recursive scan or schema parse runs here.
    const input:any = {}; input.extra = input;
    expect(await app.views["notes-list"](db,caller,input)).toBe(rows);
    expect(calls).toBe(1);
    failure = new Error("native failure identity");
    await expect(app.views["notes-list"](db,caller,{})).rejects.toBe(failure);
    expect(calls).toBe(2);
  } finally { await unlink(file); }
});

test("native generation is independent of optional validator support", async () => {
  const input = await canonical("cloudflare-d1");
  const view = {...input.plan.views["notes-list"]!,input:{type:"object" as const,properties:{unused:{type:"string" as const,format:"unsupported-test-format"}}}};
  const plan = {...input.plan,views:{...input.plan.views,"notes-list":view}};
  expect(generate({...input,plan,checked:false}).ok).toBe(true);
  expect(generate({...input,plan,checked:true}).ok).toBe(false);
});

test("SQLite native bound fields retain nullable unions and require explicit values", async () => {
  const input = await canonical("cloudflare-d1");
  const procedure = {...input.plan.procedures["create-note"]!,input:{type:"object" as const,properties:{title:{type:["boolean","null"] as ("boolean"|"null")[]}}}};
  const lower = {...input.lowered,procedures:{...input.lowered.procedures,"create-note":Object.fromEntries((["caller","trusted"] as const).map(mode=>[mode,input.lowered.procedures["create-note"]![mode]!.map((statement:LoweredStatement)=>({...statement,binds:statement.binds.map(bind=>bind.k === "input" ? {...bind,type:"bool"} : bind)}))]))}};
  const result = generate({...input,checked:false,plan:{...input.plan,procedures:{"create-note":procedure}},lowered:lower});
  if (!result.ok) throw Error(JSON.stringify(result.diagnostics));
  expect(result.files["generated.ts"]).toContain('readonly "title": number | null;');
  expect(result.files["generated.ts"]).not.toContain('readonly "title"?:');
});
