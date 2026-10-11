import { describe, expect, test } from "bun:test";
import { writeFile, unlink } from "node:fs/promises";
import { z } from "zod";
import { emitValidator } from "../src/domain/validation.js";
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
`;
async function canonical(target: Target, text = source) {
  const sqlite = target === "bun-sqlite" || target === "cloudflare-d1";
  const { lowerPlan } = await import(new URL("../../mantle/src/core/sql/lowered.ts", import.meta.url).href);
  const dialectModule = await import(new URL(sqlite ? "../../mantle/src/d1/dialect.ts" : "../../mantle/src/postgres/dialect.ts", import.meta.url).href);
  const dialect = sqlite ? dialectModule.d1Dialect : dialectModule.postgresDialect();
  const compiled = await compilePlan({ sources: [{ sourceId: "notes.yaml", text }] }, sqlite ? undefined : postgresCompile);
  if (!compiled.ok) throw Error(JSON.stringify(compiled.diagnostics));
  const { lowered } = lowerPlan(compiled.plan, dialect);
  return { target, plan: compiled.plan, lowered, viewKeys: Object.fromEntries(Object.entries(compiled.plan.views).map(([name, view]) => [name, viewOutputs(view, compiled.plan.schemas).keys])) };
}
describe("native generation", () => {
  for (const target of ["bun-sqlite", "bun-postgres", "cloudflare-d1", "cloudflare-postgres"] as const) test(target, async () => {
    const input = await canonical(target);
    const generated = generate(input);
    if (!generated.ok) throw Error(JSON.stringify(generated.diagnostics));
    const text = generated.files["generated.ts"]!;
    expect(text).toContain('["notes-list"]: view0');
    expect(text).toContain('["create-note"]: procedure0');
    expect(text).toContain("caller.subject");
    expect(text).not.toContain("RuntimePlan");
    expect(text).not.toContain("runView");
    expect(text).not.toContain("runProcedure");
    expect(text).not.toContain("jsonSchemaToZod");
    expect(text).toContain("??= z.object");
    for (const mode of ["caller", "trusted"] as const) expect(text).toContain(JSON.stringify(input.lowered.views["notes-list"]![mode]!.sql));
    if (target === "bun-sqlite") { expect(text).toContain("db.transaction(execute)()"); expect(text).toContain("SELECT changes() AS n"); }
    else if (target === "cloudflare-d1") { expect(text).toContain("db.batch(["); expect(text).toContain("INSERT INTO _mantle_assert (op,ok)"); expect(text).toContain("changes() = 1"); }
    else { expect(text).toContain("BEGIN ISOLATION LEVEL SERIALIZABLE"); expect(text).toContain('db.query("ROLLBACK")'); expect(text).toContain(".rowCount !== 1"); }
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

test("generated PG transactions preserve failures and signal uncertain ownership", async () => {
  const generated = generate(await canonical("bun-postgres"));
  if (!generated.ok) throw Error(JSON.stringify(generated.diagnostics));
  const path = new URL(`.generated-${crypto.randomUUID()}.ts`, import.meta.url);
  await writeFile(path, generated.files["generated.ts"]!.replaceAll('"@aotter/mantle-next/contracts"', '"../src/kernel/contracts.ts"'));
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
      try { await module.procedures["create-note"](db, caller, { title: "test" }); } catch (error) { caught = error; }
      if (failure === "begin") { expect(caught.code).toBe("RESOURCE_UNAVAILABLE"); expect(caught.cause).toBe(original); expect(calls.length).toBe(1); }
      else if (failure === "execute") { expect(caught.code).toBe("RESOURCE_UNAVAILABLE"); expect(caught.cause).toBe(original); expect(caught.message).not.toContain("native-execute"); expect(calls.at(-1)).toBe("ROLLBACK"); }
      else if (failure === "rollback") { expect(caught.code).toBe("OUTCOME_UNKNOWN"); expect(caught.cause.errors).toEqual([original, rollback]); }
      else if (failure === "commit-known") { expect(caught.code).toBe("RESOURCE_UNAVAILABLE"); expect(caught.cause).toBe(original); expect(calls.at(-1)).toBe("ROLLBACK"); expect(calls.filter(sql => sql.startsWith("BEGIN")).length).toBe(1); }
      else { expect(caught.code).toBe("OUTCOME_UNKNOWN"); expect(caught.cause).toBe(original); expect(calls.at(-1)).toBe("ROLLBACK"); expect(calls.filter(sql => sql === "ROLLBACK").length).toBe(1); }
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

test("PG declared integer output types include native unsafe-int8 strings", async () => {
  const integerSource = source.replace('title: {type: string}}', 'title: {type: string}, total: {type: integer}}').replace('SELECT id, title FROM notes', 'SELECT id, title, total FROM notes');
  for (const target of ["bun-postgres", "bun-sqlite"] as const) {
    const generated = generate(await canonical(target, integerSource));
    if (!generated.ok) throw Error(JSON.stringify(generated.diagnostics));
    expect(generated.files["generated.ts"]).toContain(`readonly "total": ${target === "bun-postgres" ? "number | string" : "number"} | null;`);
  }
});

test("emission removes unused input locals and binds directly for SQLite hosts", async () => {
  for (const target of ["bun-sqlite", "cloudflare-d1", "bun-postgres", "cloudflare-postgres"] as const) {
    const generated = generate(await canonical(target));
    if (!generated.ok) throw Error(JSON.stringify(generated.diagnostics));
    const text = generated.files["generated.ts"]!;
    const view = text.slice(text.indexOf("async function view0"), text.indexOf("export type Procedure0Input"));
    expect(view).toContain("validate(view0Input");
    expect(view).not.toContain("const given");
    expect(view).not.toContain("const input");
    expect(view).not.toContain("let value");
    if (target === "bun-sqlite") { expect(view).toContain(".all(uid)"); expect(view).toContain(".all()"); }
    else if (target === "cloudflare-d1") { expect(view).toContain(".bind(uid)"); expect(view).toContain(".bind()"); }
    else expect(view).toContain("values: [uid]");
    expect(text).not.toContain("...[");
    // Procedures still use validated, case-normalized inputs and scalar bind temporaries.
    expect(text).toContain("const given = validate(procedure0Input");
    expect(text).toContain('const input = { ["title"]: given["title"] }');
    expect(text).toContain("let value: any");
  }
});

test("PostgreSQL deployment requirements are explicit data without per-call SET", async () => {
  for (const target of ["bun-postgres", "cloudflare-postgres"] as const) {
    const generated = generate(await canonical(target));
    if (!generated.ok) throw Error(JSON.stringify(generated.diagnostics));
    const text = generated.files["generated.ts"]!;
    expect(text).toContain('export const postgresRequirements = { DateStyle: "ISO, YMD", IntervalStyle: "postgres", TimeZone: "UTC", standard_conforming_strings: "on", extra_float_digits: "1", statement_timeout: "10000ms" } as const;');
    expect(text).not.toContain('db.query("SET');
    expect(text).not.toContain("ALTER ROLE");
  }
});
