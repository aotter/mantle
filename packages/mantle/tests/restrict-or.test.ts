/** OR between restrict terms (ADR-0046 amendment, #2105): grammar, refusals, binds, the index rule and describe. */
import { afterAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseRestrict } from "../src/build/spec/domain/model/UserFields.js";
import { compilePlan, d1Dialect } from "../src/build/compiler.js";
import { describeApp, diffApp } from "../src/domain/describe/index.js";
import { userBinds, userRefs } from "../src/kernel/user-fields.js";
import { userCaller } from "../src/kernel/user-caller.js";
import { hostCaller } from "../src/kernel/host-caller.js";
import { generateOrThrow, link, loadFixtureSources, writeGenerated } from "./apps/link.js";
import { mantleProps } from "./gateway-fixture.js";

const directory = resolve(import.meta.dir, "apps/.generated", `restrict-or-${crypto.randomUUID()}`);
afterAll(() => rm(directory, { recursive: true, force: true }));

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

test("describe lists clauses under `or`; composition carries them; a disjunct added widens, dropped narrows", async () => {
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
  // Adding a disjunct widens: more rows match the clause.
  const wider = await describeApp(await plan(`${OR} OR member IN auth.user('teams')`));
  expect(diffApp(before, wider).find(c => c.id === "view:visible" && c.field === "restrict")?.direction).toBe(
    "widened",
  );
  // Dropping a disjunct makes the clause a single term, listed among `terms`: the same rule, matching fewer rows (#2128).
  const narrower = await describeApp(await plan("author_id = auth.uid()"));
  expect(diffApp(before, narrower).find(c => c.id === "view:visible" && c.field === "restrict")?.direction).toBe(
    "narrowed",
  );
  // AND-ing a clause onto a restrict narrows.
  const andMore = await describeApp(await plan(`(${OR}) AND member IN auth.user('teams')`));
  expect(diffApp(before, andMore).find(c => c.id === "view:visible" && c.field === "restrict")?.direction).toBe(
    "narrowed",
  );
});

// #2128: a restrict is an AND of OR-clauses. A clause `after` does not imply may admit new rows (widened); otherwise a clause
// `before` does not imply removes rows (narrowed); otherwise the rows are the same (changed). A single-term clause is
// compared as the same rule whether `describe` lists it under `terms`/`owner` or under `or`.
const A = "author_id = auth.uid()",
  O = "org IN auth.user('ownerOrgIds')",
  T = "member IN auth.user('teams')",
  L = "title IN auth.user('titles')";
// Each row: the change, the restrict before and after, the diff's direction, and the direction of the reverse change.
test.each([
  ["drop a disjunct; the clause becomes a single term", `${A} OR ${O}`, A, "narrowed", "widened"],
  ["drop a disjunct; the clause keeps two", `${A} OR ${O} OR ${T}`, `${A} OR ${O}`, "narrowed", "widened"],
  ["remove a single-term clause", `(${A} OR ${O}) AND ${T}`, `${A} OR ${O}`, "widened", "narrowed"],
  ["remove an OR-clause", `(${A} OR ${O}) AND ${T}`, T, "widened", "narrowed"],
  ["remove a clause of the distributed form", `(${A} AND ${T}) OR ${O}`, `${A} OR ${O}`, "widened", "narrowed"],
  // Mixed changes. When some clause may admit new rows the diff says widened, as a swap of terms always has; the reverse
  // of such a change can be widened too (neither plan's rows contain the other's).
  ["swap a disjunct", `${A} OR ${O}`, `${A} OR ${T}`, "widened", "widened"],
  [
    "drop a disjunct from one clause, add one to another",
    `(${A} OR ${O}) AND (${T} OR ${L})`,
    `${A} AND (${T} OR ${L} OR org IN auth.user('teams'))`,
    "widened",
    "widened",
  ],
  ["drop a disjunct and remove a clause", `(${A} OR ${O}) AND ${T}`, A, "widened", "widened"],
  ["add a disjunct and add a clause", `${A} OR ${O}`, `(${A} OR ${O} OR ${T}) AND ${L}`, "widened", "widened"],
  ["drop a disjunct and add a clause", `${A} OR ${O}`, `${A} AND ${T}`, "narrowed", "widened"],
  [
    "drop a disjunct from each of two clauses",
    `(${A} OR ${O}) AND (${T} OR ${L})`,
    `${A} AND ${T}`,
    "narrowed",
    "widened",
  ],
  // Neither: the added clause follows from one the plan has, so no row changes; the diff says changed, both ways.
  ["add a clause the plan already implies", A, `${A} AND (${A} OR ${O})`, "changed", "changed"],
] as const)("describe diff: %s", async (_, from, to, direction, reverse) => {
  const plan = async (restrict: string) => {
    const text = [docs(), view(restrict, "SELECT id, title FROM docs", "internal")].join("\n---\n");
    const r = await compilePlan({ sources: [{ sourceId: "d.yaml", text }] }, d1Dialect, "operational");
    if (!r.ok) throw Error(JSON.stringify(r.diagnostics));
    return describeApp(r.plan);
  };
  const [x, y] = [await plan(from), await plan(to)];
  // One restrict record: a clause that moves between `or` and `terms` is not reported as an unrelated remove and add.
  const restrict = (a: typeof x, b: typeof x) =>
    diffApp(a, b)
      .filter(c => c.id === "view:visible" && c.field === "restrict")
      .map(c => c.direction);
  expect(restrict(x, y)).toEqual([direction]);
  expect(restrict(y, x)).toEqual([reverse]);
});

test("two spellings of one column are one term: an OR of them collapses, an AND of them is refused", async () => {
  // SQL folds unquoted names; so does generation's column lookup.
  expect(parseRestrict("org IN auth.user('o') OR ORG IN auth.user('o')")).toEqual({
    terms: [{ column: "org", field: "o" }],
    or: [],
  });
  expect(parseRestrict("Author_id = auth.uid() OR author_id = auth.uid()")).toEqual({
    owner: "Author_id",
    terms: [],
    or: [],
  });
  for (const text of [
    "org IN auth.user('a') AND ORG IN auth.user('b')",
    "(org IN auth.user('a')) AND ORG IN auth.user('b')",
    "(org IN auth.user('a') OR ORG IN auth.user('a')) AND org IN auth.user('b')",
  ])
    expect(parseRestrict(text)).toContain("appears twice");
  // The collapsed term is a single term again: outside a clause, a missing field is refused.
  const r = await compilePlan(
    {
      sources: [
        {
          sourceId: "d.yaml",
          text: [docs(), view("org IN auth.user('o') OR ORG IN auth.user('o')")].join("\n---\n"),
        },
      ],
    },
    d1Dialect,
    "operational",
  );
  if (!r.ok) throw Error(JSON.stringify(r.diagnostics));
  expect(r.plan.views["visible"]!.restrict).toEqual({
    docs: { terms: [{ column: "org", field: "o", type: "string" }] },
  });
  expect(typeof (await generate(docs(), view("Author_id = auth.uid() OR author_id = auth.uid()")))).toBe("object");
});

test("a flat AND has no term limit; a value with OR or parentheses has at most 8 terms", () => {
  const nine = Array.from({ length: 9 }, (_, i) => `c${i} IN auth.user('f${i}')`).join(" AND ");
  expect(typeof parseRestrict(nine)).toBe("object");
  expect(parseRestrict(`(${nine})`)).toContain("at most 8 terms");
});

test("a mistake in one term of an OR restrict is reported once, whatever the clauses it lands in", async () => {
  const text = [docs(), view("(author_id = auth.uid() AND org IN auth.user('o')) OR missing IN auth.user('m')")];
  const r = await compilePlan(
    { sources: [{ sourceId: "d.yaml", text: text.join("\n---\n") }] },
    d1Dialect,
    "operational",
  );
  if (r.ok) throw Error("generated");
  expect(r.diagnostics.filter(d => d.message.includes("'missing'"))).toHaveLength(1);
});

test("the OR paging refusal names every unfixed prefix column, so the equality way it offers is bounded", async () => {
  const scoped = M("Schema", "docs", {
    title: "Docs",
    scope: "region IN auth.user('region')",
    indexes: [["region", "org", "title", "id"]],
    schema: {
      type: "object",
      required: ["region", "org", "title"],
      properties: { region: { type: "string" }, org: { type: "string" }, title: { type: "string" } },
    },
  });
  const message = await generate(scoped, view(OR));
  expect(message).toContain("past 'org', which an OR (such as a restrict OR-clause) never fixes");
  expect(message).toContain("View inputs bound with equality on 'region', 'org'");
  // That way is bounded: equalities on both prefix columns serve the index.
  const both = M("View", "visible", {
    surface: "public",
    input: {
      type: "object",
      required: ["org", "region"],
      properties: { org: { type: "string" }, region: { type: "string" } },
    },
    restrict: { docs: OR },
    sql: "SELECT id, title FROM docs WHERE region = input.region AND org = input.org ORDER BY title, id",
  });
  expect(typeof (await generate(scoped, both))).toBe("object");
  // So is the other: an index on the ordered columns.
  expect(message).toContain("or index [title, id], read in order and filtered");
  const ordered = scoped.replace('[["region","org","title","id"]]', '[["region","org","title","id"],["title","id"]]');
  expect(typeof (await generate(ordered, view(OR)))).toBe("object");
});

test("an OR in the View's own SQL gets the OR guidance, for an input and for a literal", async () => {
  const own = (where: string) =>
    M("View", "visible", {
      surface: "public",
      input: { type: "object", required: ["org"], properties: { org: { type: "string" } } },
      sql: `SELECT id, title FROM docs WHERE ${where} ORDER BY title, id`,
    });
  for (const where of [
    "org = input.org OR member = 'm'",
    "org = 'o1' OR member = input.org",
    "input.org = org OR member = 'm'",
  ])
    expect(await generate(docs([["org", "title", "id"]]), own(where))).toContain(
      "past 'org', which an OR (such as a restrict OR-clause) never fixes",
    );
});

test("INSERT into a restricted Schema: an OR-clause behaves as an IN term, trusted-only with a field scope and refused without", async () => {
  const insert = (restrict: string) =>
    M("Procedure", "add", {
      title: "Add",
      input: { type: "object", additionalProperties: false, properties: { title: { type: "string" } } },
      output: { type: "object" },
      restrict: { docs: restrict },
      handler: { sql: "INSERT INTO docs (org, title, member) VALUES ('o1', input.title, 'm') RETURNING id" },
    });
  const scoped = docs([["member", "title", "id"]], "member IN auth.user('teams')");
  for (const restrict of ["org IN auth.user('ownerOrgIds')", OR]) {
    expect(await generate(docs(), insert(restrict))).toContain(
      "Procedure INSERT/upsert into a restricted Schema, or INSERT ... SELECT into a field-scoped one, requires trusted mode",
    );
    const r = await compilePlan(
      { sources: [{ sourceId: "d.yaml", text: [scoped, insert(restrict)].join("\n---\n") }] },
      d1Dialect,
      "operational",
    );
    if (!r.ok) throw Error(JSON.stringify(r.diagnostics));
    expect(r.plan.procedures["add"]!.trustedOnly).toBe(true);
  }
  // An owner term alone is stamped from the caller, so a caller may insert.
  expect(typeof (await generate(docs(), insert("author_id = auth.uid()")))).toBe("object");
});

test("host callers: a field the host did not forward is 412 inside a clause too; a forwarded [] binds the empty set", async () => {
  const fields = { ownerOrgIds: { type: "string" as const, multiple: true } };
  const host = (user: Record<string, unknown>) =>
    hostCaller(mantleProps({ layer: "member", user: { id: "c1", ...user } as never }), { tenant: "example", fields });
  const recipe = {
    k: "user" as const,
    field: "ownerOrgIds",
    type: "string" as const,
    multiple: true,
    any: true as const,
  };
  const failure = (run: () => unknown) => {
    try {
      run();
    } catch (e: any) {
      return [e?.code, e?.status, e?.fields];
    }
  };
  for (const sqlite of [true, false]) {
    expect(userBinds(sqlite)(recipe, host({ ownerOrgIds: [] }))).toBe(sqlite ? "[]" : "{}");
    expect(failure(() => userBinds(sqlite)(recipe, host({})))).toEqual([
      "HOST_CONTRACT",
      412,
      { field: "ownerOrgIds" },
    ]);
  }
  // The generated View on the host-contract path.
  const files = await generateOrThrow("bun-sqlite", await loadFixtureSources("user-fields.yaml"));
  await writeGenerated(resolve(directory, "host"), files);
  const app = await import(resolve(directory, "host", "generated.ts")),
    db = new Database(":memory:");
  const titles = async (caller: unknown) =>
    ((await app.views["my-docs"](db, caller, {})) as { title: string }[]).map(r => r.title);
  try {
    db.exec(files["schema.sql"]!);
    await app
      .store(db, userCaller({ id: "c1" }))
      .collection("documents")
      .insert({ org: "o1", title: "mine" });
    await app
      .store(db, userCaller({ id: "x" }))
      .collection("documents")
      .insert({ org: "o2", title: "theirs" });
    expect(await titles(host({ ownerOrgIds: [] }))).toEqual(["mine"]);
    expect(await titles(host({ ownerOrgIds: ["o2"] }))).toEqual(["mine", "theirs"]);
    const refused = await titles(host({})).then(
      () => undefined,
      (e: any) => [e?.code, e?.status, e?.fields],
    );
    expect(refused).toEqual(["HOST_CONTRACT", 412, { field: "ownerOrgIds" }]);
    // The application's own callers keep the amendment's rule: a missing field is an empty set.
    expect(await titles(userCaller({ id: "c1" }, { fields }))).toEqual(["mine"]);
  } finally {
    db.close();
  }
});

test("bind capability: output with an OR-clause needs USER_REFS_V2, and a V1-only runtime refuses it instead of misreading binds", async () => {
  const v1 = await generate(docs(), view("author_id = auth.uid() AND org IN auth.user('ownerOrgIds')"));
  const v2 = await generate(docs(), view(OR));
  if (typeof v1 === "string" || typeof v2 === "string") throw Error(String(v1) + String(v2));
  expect(v1["generated.ts"]).toContain("USER.userRefs(true, 1)");
  expect(v2["generated.ts"]).toContain("USER.userRefs(true, 2)");
  expect(Object.values(v2).some(code => code.includes("USER.userRefs(true, 1)"))).toBe(false);
  // This runtime links both; an unknown version still fails.
  expect(() => userRefs(true, 1)).not.toThrow();
  expect(() => userRefs(true, 2)).not.toThrow();
  expect(() => userRefs(true, 3)).toThrow("version");
  // A runtime that knows only V1 (the user-fields module before #2105) fails to load the OR output.
  const dir = resolve(directory, "v1-runtime"),
    kernel = resolve(import.meta.dir, "../src/kernel");
  await mkdir(dir, { recursive: true });
  await writeFile(
    resolve(dir, "user-fields-v1.ts"),
    [
      `export * from ${JSON.stringify(resolve(kernel, "user-fields.ts"))};`,
      `import { userRefs as current } from ${JSON.stringify(resolve(kernel, "user-fields.ts"))};`,
      `import { ContractError } from ${JSON.stringify(resolve(kernel, "contract-error.ts"))};`,
      "export const userRefs = (sqlite: boolean, version: number) => {",
      '  if (version !== 1) throw new ContractError("USER_REFS_VERSION", "User-reference bind version differs.");',
      "  return current(sqlite, version);",
      "};",
    ].join("\n"),
  );
  await writeFile(
    resolve(dir, "generated.ts"),
    link(v2["generated.ts"]!.replace('"@aotter/mantle/internal/user-fields"', '"USER_FIELDS_V1"')).replace(
      '"USER_FIELDS_V1"',
      JSON.stringify(resolve(dir, "user-fields-v1.ts")),
    ),
  );
  const code = await import(resolve(dir, "generated.ts")).then(
    () => "linked",
    (e: any) => e?.code ?? String(e),
  );
  expect(code).toBe("USER_REFS_VERSION");
});
