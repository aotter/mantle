/** OR between restrict terms (ADR-0046 amendment, #2105): grammar, refusals, binds, the index rule and describe. */
import { expect, test } from "bun:test";
import { parseRestrict } from "../src/build/spec/domain/model/UserFields.js";
import { compilePlan, d1Dialect } from "../src/build/compiler.js";
import { describeApp, diffApp } from "../src/domain/describe/index.js";
import { userBinds } from "../src/kernel/user-fields.js";
import { userCaller } from "../src/kernel/user-caller.js";
import { generateOrThrow } from "./apps/link.js";

const M = (kind: string, name: string, spec: object) =>
  JSON.stringify({ apiVersion: "cms.mantle.aotter.net/v2", kind, metadata: { name }, spec });
const docs = (indexes: string[][] = [["title", "id"]], scope?: string) =>
  M("Schema", "docs", {
    title: "Docs",
    ...(scope ? { scope } : {}),
    indexes,
    schema: {
      type: "object",
      required: ["org", "title", "member"],
      properties: { org: { type: "string" }, title: { type: "string" }, member: { type: "string" } },
    },
  });
const OR = "author_id = auth.uid() OR org IN auth.user('ownerOrgIds')";
const view = (restrict: string, sql = "SELECT id, title FROM docs ORDER BY title, id", surface = "public") =>
  M("View", "visible", { surface, restrict: { docs: restrict }, sql });
const generate = (...documents: string[]) =>
  generateOrThrow("bun-sqlite", [{ sourceId: "or.yaml", text: documents.join("\n---\n") }]).then(
    files => files,
    (e: Error) => e.message,
  );

test("AND binds tighter than OR; parentheses group; the result is an AND of sorted OR-clauses", () => {
  expect(parseRestrict(OR)).toEqual({
    terms: [],
    or: [[{ owner: "author_id" }, { column: "org", field: "ownerOrgIds" }]],
  });
  // (a AND b) OR c  ==  (a OR c) AND (b OR c)
  expect(parseRestrict("a IN auth.user('x') AND b IN auth.user('y') OR author_id = auth.uid()")).toEqual({
    terms: [],
    or: [
      [{ owner: "author_id" }, { column: "a", field: "x" }],
      [{ owner: "author_id" }, { column: "b", field: "y" }],
    ],
  });
  expect(parseRestrict("(a IN auth.user('x') or author_id = auth.uid()) AND b IN auth.user('y')")).toEqual({
    terms: [{ column: "b", field: "y" }],
    or: [[{ owner: "author_id" }, { column: "a", field: "x" }]],
  });
  // Without OR or parentheses the parse is the AND-only one, unchanged; redundant parentheses add nothing.
  expect(parseRestrict("author_id = auth.uid() AND a IN auth.user('x')")).toEqual({
    owner: "author_id",
    terms: [{ column: "a", field: "x" }],
    or: [],
  });
  expect(parseRestrict("((author_id = auth.uid()))")).toEqual({ owner: "author_id", terms: [], or: [] });
  // One column may be compared with two fields in different branches; a repeated clause is kept once.
  expect(
    parseRestrict("(a IN auth.user('x') OR a IN auth.user('y')) AND (a IN auth.user('y') OR a IN auth.user('x'))"),
  ).toEqual({
    terms: [],
    or: [
      [
        { column: "a", field: "x" },
        { column: "a", field: "y" },
      ],
    ],
  });
  for (const [text, message] of [
    ["author_id = auth.uid() OR org IN auth.memberOf('owner')", "unsupported term 'org IN auth.memberOf('owner')'"],
    ["author_id = auth.uid() OR org = auth.user('x')", "unsupported term 'org = auth.user('x')'"],
    ["(author_id = auth.uid() OR org IN auth.user('x')", "unbalanced parentheses"],
    ["author_id = auth.uid()) OR org IN auth.user('x')", "unbalanced parentheses"],
    ["author_id = auth.uid() OR", "a term is expected before 'the end'"],
    ["OR author_id = auth.uid()", "a term is expected before 'OR'"],
    ["org IN auth.user('x') OR ()", "a term is expected before ')'"],
    ["a IN auth.user('x') AND a IN auth.user('y') OR author_id = auth.uid()", "column 'a' or field 'y' appears twice"],
    ["author_id = auth.uid() AND owner = auth.uid() OR a IN auth.user('x')", "at most one `= auth.uid()` term"],
    ["org IN auth.user('id') OR author_id = auth.uid()", "invalid or reserved user field 'id'"],
    [Array.from({ length: 9 }, (_, i) => `c${i} IN auth.user('f${i}')`).join(" OR "), "at most 8 terms"],
  ])
    expect(parseRestrict(text)).toContain(message!);
});

test("generation validates every term of a clause and keeps scope AND-only", async () => {
  for (const [restrict, message] of [
    [
      "author_id = auth.uid() OR missing IN auth.user('ownerOrgIds')",
      "restrict column 'missing' is not a field of 'docs'",
    ],
    ["member = auth.uid() OR org IN auth.user('ownerOrgIds')", "restrict 'member = auth.uid()'"],
    ["author_id = auth.uid() OR org IN auth.memberOf('owner')", "restrict: unsupported term"],
  ])
    expect(await generate(docs(), view(restrict!))).toContain(message!);
  expect(
    await generate(
      M("View", "visible", { surface: "public", restrict: { other: OR }, sql: "SELECT id FROM docs ORDER BY id" }),
      docs(),
    ),
  ).toContain("restrict key 'other' is not a Schema this target's SQL reads");
  expect(
    await generate(docs([["org", "id"]], "org IN auth.user('orgIds') OR org IN auth.user('ownerOrgIds')")),
  ).toContain("scope is AND-only; OR and parentheses are accepted only in a View or Procedure restrict");
  // A ref handler still refuses restrict.
  const refProcedure = M("Procedure", "by-ref", {
    title: "By ref",
    input: { type: "object", additionalProperties: false },
    output: { type: "object" },
    restrict: { docs: OR },
    handler: { ref: "docs.byRef" },
  });
  expect(await generate(docs(), refProcedure)).toContain("restrict applies to SQL Procedures");
});

test("every column of a clause is never SET, and a caller INSERT into an OR-restricted Schema is trusted-only", async () => {
  const procedure = (sql: string) =>
    M("Procedure", "write", {
      title: "Write",
      input: { type: "object", additionalProperties: false, properties: { id: { type: "string" } } },
      output: { type: "object" },
      restrict: { docs: OR },
      handler: { sql },
    });
  expect(await generate(docs(), procedure("UPDATE docs SET org = 'o9' WHERE id = input.id RETURNING id"))).toContain(
    "The scoped column is never writable through SET.",
  );
  expect(
    await generate(docs(), procedure("INSERT INTO docs (org, title, member) VALUES ('o1', 't', 'm') RETURNING id")),
  ).toContain("requires trusted mode");
  const files = await generate(docs(), procedure("UPDATE docs SET title = 'x' WHERE id = input.id RETURNING id"));
  expect(typeof files).toBe("object");
});

test("index rule: an OR-clause never fixes an index prefix; an equality input or an ordered-columns index serves", async () => {
  const head =
    "ORDER BY (title) needs index [org, title, id] past 'org', which an OR (such as a restrict OR-clause) never fixes: every page would sort all of the caller's matching rows. Bounded: a View input bound with equality on that column; or index [title, id], read in order and filtered (handbook: reference/schema.md#index-prefixes-for-paged-views).";
  expect(await generate(docs([["org", "title", "id"]]), view(OR))).toContain(head);
  // The same index serves when `org` alone is a unit term with an equality (here an input), or the ordered columns are indexed.
  const byInput = M("View", "visible", {
    surface: "public",
    input: { type: "object", required: ["org"], properties: { org: { type: "string" } } },
    restrict: { docs: OR },
    sql: "SELECT id, title FROM docs WHERE org = input.org ORDER BY title, id",
  });
  expect(typeof (await generate(docs([["org", "title", "id"]]), byInput))).toBe("object");
  expect(
    typeof (await generate(
      docs([
        ["org", "title", "id"],
        ["title", "id"],
      ]),
      view(OR),
    )),
  ).toBe("object");
  // An owner term fixes `author_id` alone, but not inside a clause: the owner-first index no longer serves.
  const own = await generate(docs([["authorId", "title", "id"]]), view("author_id = auth.uid()"));
  expect(typeof own).toBe("object");
  expect(await generate(docs([["authorId", "title", "id"]]), view(OR))).toContain(
    "past 'authorId', which an OR (such as a restrict OR-clause) never fixes",
  );
});

test("binds: a missing or empty field in a clause is an empty set; { all: true } and anonymous are still refused", () => {
  const recipe = {
    k: "user" as const,
    field: "ownerOrgIds",
    type: "string" as const,
    multiple: true,
    any: true as const,
  };
  const fields = { ownerOrgIds: { type: "string" as const, multiple: true } };
  const empty = userCaller({ id: "u", ownerOrgIds: [] }, { fields }),
    missing = userCaller({ id: "u" }, { fields }),
    every = userCaller({ id: "u", ownerOrgIds: { all: true } }, { fields });
  for (const sqlite of [true, false]) {
    expect(userBinds(sqlite)(recipe, empty)).toBe(sqlite ? "[]" : "{}");
    expect(userBinds(sqlite)(recipe, missing)).toBe(sqlite ? "[]" : "{}");
    expect(() => userBinds(sqlite)(recipe, every)).toThrow("does not lift a restrict");
    expect(() => userBinds(sqlite)(recipe, { kind: "anonymous" })).toThrow("require an authenticated caller");
    // Outside a clause the empty set is still refused.
    expect(() => userBinds(sqlite)({ ...recipe, any: undefined }, empty)).toThrow("has no value");
  }
});

test("describe lists clauses under `or`; composition carries them; changing a clause widens", async () => {
  const plan = async (restrict: string) => {
    const text = [
      docs(),
      view(restrict, "SELECT id, title FROM docs", "internal"),
      M("View", "wrapper", { surface: "internal", sql: "SELECT id FROM visible ORDER BY id" }),
    ].join("\n---\n");
    const r = await compilePlan({ sources: [{ sourceId: "d.yaml", text }] }, d1Dialect, "operational");
    if (!r.ok) throw Error(JSON.stringify(r.diagnostics));
    return r.plan;
  };
  const clause = [{ column: "org", field: "ownerOrgIds", type: "string" as const }, { owner: "author_id" }];
  const before = await describeApp(await plan(OR));
  const meta = (id: string, d = before) => d.targets.find(t => t._meta.id === id)!._meta;
  expect(meta("view:visible").restrict).toEqual({ docs: { terms: [], or: [clause] } });
  expect(meta("view:wrapper").restrict).toEqual({ docs: { terms: [], or: [clause] } });
  // Adding a disjunct widens: the old clause is gone.
  const wider = await describeApp(await plan(`${OR} OR member IN auth.user('teams')`));
  expect(diffApp(before, wider).find(c => c.id === "view:visible" && c.field === "restrict")?.direction).toBe(
    "widened",
  );
  // Dropping a disjunct makes the clause a single term: a lost conjunct, so the diff reports a widening (a swap is one).
  const narrower = await describeApp(await plan("author_id = auth.uid()"));
  expect(diffApp(before, narrower).find(c => c.id === "view:visible" && c.field === "restrict")?.direction).toBe(
    "widened",
  );
  // AND-ing a clause onto a restrict narrows.
  const andMore = await describeApp(await plan(`(${OR}) AND member IN auth.user('teams')`));
  expect(diffApp(before, andMore).find(c => c.id === "view:visible" && c.field === "restrict")?.direction).toBe(
    "narrowed",
  );
});
