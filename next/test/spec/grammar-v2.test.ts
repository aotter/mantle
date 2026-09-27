import { describe, expect, it } from "vitest";
import { isRowOp, pinnedId, procedureTarget } from "../../src/spec/index.js";
import type { ProcedureManifest, StoreProgramOp } from "../../src/spec/domain/model/ManifestGrammar.js";
import { parseManifests, validateManifests } from "./parse.js";

/** The v2 grammar rules of ADR-0032 decision 5 that have no v1 counterpart. */

const header = "apiVersion: cms.mantle.aotter.net/v2";
const codes = (yaml: string) => parseManifests(yaml).diagnostics.map((d) => d.code);
const errors = (yaml: string) => parseManifests(yaml).diagnostics.filter((d) => d.severity === "error");
/** Parse, then run the graph rules over the parsed manifests. */
const graphCodes = (yaml: string) => {
  const parsed = parseManifests(yaml);
  expect(parsed.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  return validateManifests({ manifests: parsed.manifests }).diagnostics.map((d) => d.code);
};

const posts = `${header}
kind: Schema
metadata: { name: posts }
spec:
  title: Posts
  schema:
    type: object
    properties: { slug: { type: string }, title: { type: string } }
  uniqueIndexes: [[slug]]
`;
const events = `${header}
kind: Schema
metadata: { name: events }
spec:
  title: Events
  lifecycle: operational
  schema:
    type: object
    properties: { kind: { type: string }, at: { type: integer } }
`;
const scoped = `${header}
kind: Schema
metadata: { name: sessions }
spec:
  title: Sessions
  schema:
    type: object
    properties: { ownerId: { type: string } }
    required: [ownerId]
  indexes: [[ownerId]]
  scope: { ownerId: $ctx.user.id }
`;

describe("apiVersion", () => {
  it("rejects v1 with a pointer to mantle-update", () => {
    const [diagnostic] = parseManifests(posts.replace("/v2", "/v1")).diagnostics;
    expect(diagnostic?.code).toBe("INVALID_MANIFEST_ENVELOPE");
    expect(diagnostic?.suggestion).toContain("mantle-update");
  });
});

describe("removed v1 keys", () => {
  it.each([
    ["View from", `${header}\nkind: View\nmetadata: { name: v }\nspec: { surface: public, from: posts }`],
    ["View filter", `${header}\nkind: View\nmetadata: { name: v }\nspec: { surface: public, select: { from: posts }, filter: { eq: { field: slug, value: a } } }`],
    ["View params", `${header}\nkind: View\nmetadata: { name: v }\nspec: { surface: public, select: { from: posts }, params: { type: object, properties: {} } }`],
    ["builtin handler", `${header}\nkind: Procedure\nmetadata: { name: p }\nspec: { input: { type: object }, output: { type: object }, handler: { kind: builtin, op: create, schema: posts } }`],
    ["errorPolicy", `${header}\nkind: Trigger\nmetadata: { name: t }\nspec: { source: { kind: lifecycle, schema: posts, on: [after_create], errorPolicy: continue }, target: { procedure: p } }`],
  ])("rejects %s", (_name, yaml) => {
    expect(errors(yaml).length).toBeGreaterThan(0);
  });

  it("points a v1 handler at mantle-update", () => {
    const [diagnostic] = parseManifests(`${header}\nkind: Procedure\nmetadata: { name: p }\nspec: { input: { type: object }, output: { type: object }, handler: { kind: ref, ref: p } }`).diagnostics;
    expect(diagnostic?.suggestion).toContain("mantle-update");
  });
});

describe("View input and value references", () => {
  const view = (input: string, where: string) => `${posts}---
${header}
kind: View
metadata: { name: by-slug }
spec:
  surface: public
  input: ${input}
  select: { from: posts, where: ${where} }
`;
  it("binds a required scalar input", () => {
    expect(errors(view("{ type: object, properties: { slug: { type: string } }, required: [slug] }", "{ slug: $input.slug }"))).toEqual([]);
  });
  it("rejects unknown, optional and non-scalar references", () => {
    expect(codes(view("{ type: object, properties: { slug: { type: string } }, required: [slug] }", "{ slug: $input.other }"))).toContain("STORE_REFERENCE_UNKNOWN");
    expect(codes(view("{ type: object, properties: { slug: { type: string } } }", "{ slug: $input.slug }"))).toContain("STORE_REFERENCE_NOT_REQUIRED");
    expect(codes(view("{ type: object, properties: { slug: { type: object } }, required: [slug] }", "{ slug: $input.slug }"))).toContain("STORE_REFERENCE_UNKNOWN");
    expect(codes(view("{ type: object, properties: {} }", "{ slug: $param }"))).toContain("STORE_REFERENCE_UNKNOWN");
  });
  it("accepts $literal for a string that starts with $", () => {
    expect(errors(view("{ type: object, properties: {} }", "{ slug: { $literal: $5 } }"))).toEqual([]);
  });
  it.each(["limit", "cursor"])("reserves %s for pagination", (name) => {
    expect(codes(view(`{ type: object, properties: { ${name}: { type: string } }, required: [${name}] }`, "{ slug: a }"))).toContain("VIEW_INPUT_RESERVED_NAME");
  });
  it("no longer reserves page or show", () => {
    expect(errors(view("{ type: object, properties: { page: { type: string } }, required: [page] }", "{ slug: $input.page }"))).toEqual([]);
  });
});

describe("native SQL Views", () => {
  it("may not read a scoped Schema", () => {
    const yaml = `${scoped}---
${header}
kind: View
metadata: { name: raw }
spec: { surface: staff, sql: "SELECT * FROM sessions" }
`;
    expect(graphCodes(yaml)).toContain("VIEW_SQL_SCOPED_SCHEMA");
  });
});

describe("schedule cron", () => {
  const schedule = (cron: string) => `${header}
kind: Procedure
metadata: { name: tick }
spec: { input: { type: object }, output: { type: object }, handler: { ref: tick } }
---
${header}
kind: Trigger
metadata: { name: nightly }
spec: { source: { kind: schedule, cron: "${cron}" }, target: { procedure: tick } }
`;
  it("is POSIX: weekday 0 is Sunday and 7 is out of range", () => {
    expect(errors(schedule("0 3 * * 0"))).toEqual([]);
    expect(errors(schedule("0 3 * * 1-5"))).toEqual([]);
    expect(errors(schedule("0 3 * * 7")).length).toBeGreaterThan(0);
  });
});

describe("lifecycle hook targets", () => {
  const hook = (handler: string) => `${events}---
${header}
kind: Procedure
metadata: { name: audit }
spec: { input: { type: object }, output: { type: object }, handler: ${handler} }
---
${header}
kind: Trigger
metadata: { name: on-event }
spec: { source: { kind: lifecycle, schema: events, on: [after_create] }, target: { procedure: audit } }
`;
  it("must be a ref handler", () => {
    expect(graphCodes(hook("{ ref: audit }"))).not.toContain("HANDLER_REF_REQUIRED");
    expect(graphCodes(hook("{ store: [{ insert: events, values: { kind: audit } }] }"))).toContain("HANDLER_REF_REQUIRED");
  });
});

describe("Store program classification", () => {
  const update = (where: Record<string, unknown>): StoreProgramOp => ({ update: "posts", set: { title: "x" }, where });
  it("treats a where that pins id, alone or ANDed, as a row op", () => {
    expect(isRowOp(update({ id: "$input.id" }))).toBe(true);
    expect(isRowOp(update({ id: "$input.id", title: { gte: "a" } }))).toBe(true);
    expect(isRowOp({ insert: "posts", values: { title: "$input.title" } })).toBe(true);
  });
  it("treats anything else as a set op", () => {
    expect(isRowOp(update({ slug: "a" }))).toBe(false);
    expect(isRowOp(update({ id: { in: ["a", "b"] } }))).toBe(false);
    // Only the equality shorthand pins; an operator form is a set op, the safe side.
    expect(isRowOp(update({ id: { eq: "$input.id" } }))).toBe(false);
    expect(isRowOp(update({ or: [{ id: "a" }, { id: "b" }] }))).toBe(false);
    expect(pinnedId({ id: null })).toBeUndefined();
  });
  it("infers Procedure.target from the one op that pins id to an input", () => {
    const procedure = (store: readonly StoreProgramOp[], target?: ProcedureManifest["spec"]["target"]): ProcedureManifest => ({
      apiVersion: "cms.mantle.aotter.net/v2", kind: "Procedure", metadata: { name: "p" },
      spec: { input: { type: "object" }, output: { type: "object" }, handler: { store }, ...(target ? { target } : {}) },
    });
    expect(procedureTarget(procedure([{ update: "posts", set: { title: "$input.title" }, where: { id: "$input.id" }, lock: "$input.expectedVersion" }])))
      .toEqual({ schema: "posts", id: "id", version: "expectedVersion" });
    expect(procedureTarget(procedure([{ insert: "posts", values: { title: "$input.title" } }]))).toBeUndefined();
    expect(procedureTarget(procedure([
      { delete: "posts", where: { id: "$input.a" } },
      { delete: "posts", where: { id: "$input.b" } },
    ]))).toBeUndefined();
    expect(procedureTarget(procedure([{ delete: "posts", where: { id: "$input.a" } }], { schema: "events", id: "b" })))
      .toEqual({ schema: "events", id: "b" });
  });
});
