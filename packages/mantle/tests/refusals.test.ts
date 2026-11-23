import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { generateFromSources } from "../src/infrastructure/generateAuth.js";
import { compilePlan, compileProgram, d1Dialect, postgresDialect } from "../src/build/compiler.js";
import { wireScalars } from "../src/domain/wireScalars.js";
import { dialect } from "../src/kernel/dialect/sqlite.js";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeGenerated } from "./apps/link.js";
import { userCaller } from "../src/kernel/user-caller.js";

const doc = (kind: string, name: string, spec: object) =>
  JSON.stringify({ apiVersion: "cms.mantle.aotter.net/v2", kind, metadata: { name }, spec });
const schema = {
  title: "Notes",
  lifecycle: "operational",
  schema: { type: "object", properties: { slug: { type: "string" }, title: { type: "string" } } },
};
const localized = {
  ...schema,
  localized: true,
  schema: { ...schema.schema, properties: { ...schema.schema.properties, locale: { type: "string" } } },
};
const procedure = {
  input: { type: "object" },
  output: { type: "object" },
  handler: { sql: "INSERT INTO notes (title) VALUES ('hello') RETURNING id" },
};
const base = [doc("Schema", "notes", schema), doc("Procedure", "read", procedure)];
async function diagnostics(extra: string[]) {
  const result = await generateFromSources({
    target: "bun-sqlite",
    sources: { sources: [{ sourceId: "refused.yaml", text: [...base, ...extra].join("\n---\n") }] },
  });
  expect(result.ok).toBe(false);
  if (result.ok) throw Error("unsupported declaration generated successfully");
  return result.diagnostics;
}

for (const [kind, source, hint] of [
  ["schedule", "{kind: schedule, cron: '0 * * * *'}", "Schedule Triggers are unsupported. Wire scheduled() yourself."],
  [
    "lifecycle",
    "{kind: lifecycle, schema: notes, on: [after_create]}",
    "Before/after lifecycle hooks are unsupported. Write a custom handler.",
  ],
] as const) {
  test(`a ${kind} Trigger fails the manifest with one actionable diagnostic per declaration`, async () => {
    const trigger = (name: string) =>
      `apiVersion: cms.mantle.aotter.net/v2\nkind: Trigger\nmetadata: {name: ${name}}\nspec:\n  source: ${source}\n  target: {procedure: read}`;
    const result = await diagnostics([trigger("first"), trigger("second")]);
    expect(result).toEqual(
      ["[doc 2]", "[doc 3]"].map(doc => ({
        code: "INVALID_MANIFEST_ENVELOPE",
        path: "/spec/source/kind",
        message: `${doc} Trigger.spec.source.kind '${kind}' is not accepted (one of http, mcp). ${hint}`,
      })),
    );
    const compiled = await compilePlan({
      sources: [{ sourceId: "refused.yaml", text: [...base, trigger("first")].join("\n---\n") }],
    });
    expect(compiled.ok).toBe(false);
    if (!compiled.ok)
      expect(compiled.diagnostics).toEqual([
        expect.objectContaining({
          path: "/spec/source/kind",
          source: expect.objectContaining({
            sourceId: "refused.yaml",
            documentIndex: 2,
            span: expect.objectContaining({ start: expect.objectContaining({ line: 9, column: 18 }) }),
          }),
        }),
      ]);
  });
}

test("requires.guard fails each View and Procedure that declares it", async () => {
  const requires = { guard: { procedure: "read" } };
  const result = await diagnostics([
    doc("View", "guarded", { surface: "internal", requires, sql: "SELECT id FROM notes" }),
    doc("Procedure", "guarded-procedure", { ...procedure, requires }),
  ]);
  const hint =
    "Dynamic authorization guards are unsupported. Write a custom handler that checks authorization before executing queries.";
  expect(result).toEqual(
    [
      ["View", 2],
      ["Procedure", 3],
    ].map(([kind, index]) => ({
      code: "INVALID_MANIFEST_ENVELOPE",
      path: "/spec/requires/guard",
      message: `[doc ${index}] ${kind}.spec.requires.guard is not accepted. ${hint}`,
    })),
  );
});

test("each native geo View output is refused with an explicit scalar alternative", async () => {
  const result = await diagnostics([
    doc("Schema", "places", {
      ...schema,
      schema: {
        type: "object",
        properties: { point: { type: "object", format: "geo" }, other: { type: "object", format: "geo" } },
      },
    }),
    doc("View", "places", { surface: "internal", sql: "SELECT point, other FROM places" }),
  ]);
  expect(result).toHaveLength(2);
  expect(result.map(d => d.path)).toEqual(["views/places/columns/point", "views/places/columns/other"]);
  for (const d of result) expect(d.message).toContain("Select the latitude and longitude columns explicitly.");
});

test("geo provenance survives CTEs and subqueries; physical scalar columns remain supported", async () => {
  const places = doc("Schema", "places", {
    ...schema,
    schema: { type: "object", properties: { point: { type: "object", format: "geo" } } },
  });
  const result = await diagnostics([
    places,
    doc("View", "nested", {
      surface: "internal",
      sql: "WITH c AS (SELECT point AS p FROM places) SELECT q.p AS position FROM (SELECT p FROM c) q",
    }),
  ]);
  expect(result).toEqual([
    {
      code: "GENERATE_UNSUPPORTED",
      path: "views/nested/columns/position",
      message: "Native geo projection is unsupported. Select the latitude and longitude columns explicitly.",
    },
  ]);
  const scalar = await generateFromSources({
    target: "bun-sqlite",
    sources: {
      sources: [
        {
          sourceId: "geo.yaml",
          text: [
            places,
            doc("View", "coordinates", { surface: "internal", sql: "SELECT point_lat, point_lng FROM places" }),
          ].join("\n---\n"),
        },
      ],
    },
  });
  expect(scalar.ok).toBe(true);
});

test("unmatched date-time SELECT outputs give an actionable expansion hint", () => {
  const ast = { SelectStmt: { targetList: [{ ResTarget: { val: { ColumnRef: { fields: [{ A_Star: {} }] } } } }] } };
  expect(wireScalars(ast, ["created_at"], ["timestamptz"], dialect)).toBe(
    "Declared timestamp and date outputs need one SELECT item per output. Expand the SELECT list explicitly.",
  );
});

test("a noncanonical input cast and another refused declaration are reported together", () => {
  const text = [
    doc("Schema", "local", localized),
    doc("View", "bad-cast", {
      surface: "internal",
      input: { type: "object", properties: { payload: { type: "object" } } },
      sql: "SELECT input.payload AS value",
    }),
    doc("Schema", "places", {
      ...schema,
      schema: { type: "object", properties: { point: { type: "object", format: "geo" } } },
    }),
    doc("View", "places", { surface: "internal", sql: "SELECT point FROM places" }),
  ].join("\n---\n");
  // The compiler normally supplies canonical casts. Corrupt one lowering in an isolated process.
  // The source generator imports the compiler from src/build; the published dist bundles it into one module.
  const lowered = new URL("../src/build/core/sql/lowered.ts", import.meta.url).href;
  const script = `import { mock } from "bun:test";
const original = await import(${JSON.stringify(lowered)});
const lowerPlan = original.lowerPlan;
mock.module(${JSON.stringify(lowered)}, () => ({ ...original, lowerPlan(...args) {
  const result = lowerPlan(...args);
  for (const statement of Object.values(result.lowered.views["bad-cast"])) statement.sql = "SELECT $1 AS value";
  return result;
} }));
const { generateFromSources } = await import(${JSON.stringify(new URL("../src/infrastructure/generate.ts", import.meta.url).href)});
console.log(JSON.stringify(await generateFromSources({ target: "bun-postgres", sources: { sources: [{ sourceId: "mixed.yaml", text: ${JSON.stringify(text)} }] } })));`;
  const result = JSON.parse(execFileSync(process.execPath, ["-e", script], { encoding: "utf8" }));
  expect(result.ok).toBe(false);
  expect(result.diagnostics).toContainEqual({
    code: "GENERATE_UNSUPPORTED",
    path: "views/bad-cast",
    message: "Input $1 must appear only as CAST($1 AS jsonb). Wrap each occurrence in CAST($1 AS jsonb).",
  });
  expect(result.diagnostics).toContainEqual({
    code: "GENERATE_UNSUPPORTED",
    path: "views/places/columns/point",
    message: "Native geo projection is unsupported. Select the latitude and longitude columns explicitly.",
  });
}, 30_000);

test("ORDER BY over a subquery, CTE or internal View without id names ORDER BY and the fix (#1975)", async () => {
  const subquery = "ORDER BY over x, a subquery in FROM (or an internal View it reads), needs it to output id",
    cte = "ORDER BY over x, a CTE (or an internal View it reads), needs it to output id";
  const fix =
    "Core appends x.id as the last ORDER BY key so the order is total. Select the row's id in it, or GROUP BY in this SELECT (Core then orders by the group keys).";
  const ranked = doc("View", "ranked", { surface: "internal", sql: "SELECT title FROM notes" });
  for (const target of ["bun-sqlite", "bun-postgres"] as const)
    for (const [sql, refusal, extra] of [
      ["SELECT x.title FROM (SELECT title FROM notes) x ORDER BY x.title", subquery],
      ["SELECT x.n FROM (SELECT title, COUNT(*) AS n FROM notes GROUP BY title) x ORDER BY x.n", subquery],
      ["WITH x AS (SELECT title FROM notes) SELECT x.title FROM x ORDER BY x.title", cte],
      // an internal View read in FROM is a CTE on SQLite and a subquery on PostgreSQL
      ["SELECT x.title FROM ranked x ORDER BY x.title", target === "bun-sqlite" ? cte : subquery, ranked],
    ] as const) {
      const text = [...base, ...(extra ? [extra] : []), doc("View", "ordered", { surface: "internal", sql })].join(
        "\n---\n",
      );
      const result = await generateFromSources({ target, sources: { sources: [{ sourceId: "refused.yaml", text }] } });
      expect(result.ok, `${target} ${sql}`).toBe(false);
      if (!result.ok)
        expect(result.diagnostics).toEqual([
          {
            code: "GENERATE_UNSUPPORTED",
            path: "views/ordered",
            message: `This View's caller SQL could not be lowered: ${refusal}: ${fix}`,
          },
        ]);
    }
  // On a paged surface the lowering's reason is the only diagnostic: no second, unrelated paging refusal.
  for (const target of ["bun-sqlite", "bun-postgres"] as const)
    for (const surface of ["public", "admin"] as const) {
      const sql = "SELECT x.title FROM (SELECT title FROM notes) x ORDER BY x.title";
      const text = [...base, doc("View", "ordered", { surface, sql })].join("\n---\n");
      const result = await generateFromSources({ target, sources: { sources: [{ sourceId: "refused.yaml", text }] } });
      expect(result.ok).toBe(false);
      if (!result.ok)
        expect(result.diagnostics).toEqual([
          {
            code: "GENERATE_UNSUPPORTED",
            path: "views/ordered",
            message: `This View's ${surface === "public" ? "public" : "caller"} SQL could not be lowered: ${subquery}: ${fix}`,
          },
        ]);
    }
  // selecting the id makes each of them generate
  for (const target of ["bun-sqlite", "bun-postgres"] as const)
    for (const sql of [
      "SELECT x.id, x.title FROM (SELECT id, title FROM notes) x ORDER BY x.title",
      "WITH x AS (SELECT id, title FROM notes) SELECT x.id, x.title FROM x ORDER BY x.title",
    ]) {
      const text = [...base, doc("View", "ordered", { surface: "internal", sql })].join("\n---\n");
      const result = await generateFromSources({ target, sources: { sources: [{ sourceId: "ok.yaml", text }] } });
      expect(result.ok, `${target} ${sql}`).toBe(true);
    }
});

test("a paged View's ORDER BY that cannot be its cursor, and OFFSET, are refused with the form to use (#1975)", async () => {
  const notColumn =
    "ORDER BY key 1 is not a column: a paged View's cursor is its ORDER BY keys, so each is a Schema field, id or a GROUP BY key, selected or not. Order by the column itself; a computed order is accepted only in an internal View, which is not paged.";
  for (const target of ["bun-sqlite", "bun-postgres"] as const) {
    for (const [sql, message] of [
      ["SELECT id, title FROM notes ORDER BY lower(title), id", notColumn],
      ["SELECT id, title FROM notes ORDER BY CASE WHEN title IS NULL THEN 0 ELSE 1 END, id", notColumn],
      [
        "SELECT COUNT(*) AS n FROM notes ORDER BY 1",
        "An aggregate without GROUP BY returns one row: remove its ORDER BY.",
      ],
    ] as const) {
      const text = [...base, doc("View", "ordered", { surface: "public", sql })].join("\n---\n");
      const result = await generateFromSources({ target, sources: { sources: [{ sourceId: "refused.yaml", text }] } });
      expect(result.ok, `${target} ${sql}`).toBe(false);
      if (!result.ok)
        expect(result.diagnostics).toEqual([{ code: "GENERATE_UNSUPPORTED", path: "views/ordered", message }]);
      // an internal View is not paged, so the same order generates
      const internal = [...base, doc("View", "ordered", { surface: "internal", sql })].join("\n---\n");
      const ok = await generateFromSources({ target, sources: { sources: [{ sourceId: "ok.yaml", text: internal }] } });
      expect(ok.ok, `${target} internal ${sql}`).toBe(true);
    }
    const text = [
      ...base,
      doc("View", "ordered", { surface: "internal", sql: "SELECT id FROM notes ORDER BY id LIMIT 10 OFFSET 10" }),
    ].join("\n---\n");
    const result = await generateFromSources({ target, sources: { sources: [{ sourceId: "refused.yaml", text }] } });
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.diagnostics).toEqual([
        expect.objectContaining({
          code: "SQL_UNSUPPORTED",
          message: expect.stringContaining(
            "OFFSET is refused: a View pages with its generated cursor (`limit`, then `cursor` from the previous page's `nextCursor`) over its ORDER BY keys",
          ),
        }),
      ]);
  }
});

test("CROSS JOIN and a comma join name JOIN … ON true, which pairs every row under each side's row policy (#1976)", async () => {
  const owned = (name: string) =>
    doc("Schema", name, {
      title: name,
      lifecycle: "operational",
      scope: "owner = auth.uid()",
      indexes: [["owner"]],
      schema: {
        type: "object",
        required: ["owner", "label"],
        properties: { owner: { type: "string" }, label: { type: "string" } },
      },
    });
  const text = (sql: string) =>
    [owned("people"), owned("items"), doc("View", "pairs", { surface: "internal", sql })].join("\n---\n");
  for (const target of ["bun-sqlite", "bun-postgres"] as const) {
    const refused = async (sql: string) => {
      const result = await generateFromSources({
        target,
        sources: { sources: [{ sourceId: "x.yaml", text: text(sql) }] },
      });
      return result.ok ? [] : result.diagnostics.map(d => `${d.code} ${d.message}`);
    };
    expect(await refused("SELECT p.id, i.id AS item FROM people p CROSS JOIN items i")).toEqual([
      'SQL_SHAPE SQL 1:41 near "CROSS JOIN": a JOIN needs ON: CROSS JOIN is refused, write JOIN … ON true to pair every row of both sides (row policy applies to each)',
    ]);
    // the comma join points at the relation after the comma, not at the SELECT
    expect(await refused("SELECT p.id, i.id AS item FROM people p, items i")).toEqual([
      `SQL_SHAPE SQL 1:42 near "items": a comma join is refused (except ${target === "bun-postgres" ? "a row source over a column, and LATERAL" : "json_each"}): write JOIN … ON <condition>, or JOIN … ON true to pair every row of both sides`,
    ]);
    const result = await generateFromSources({
      target,
      sources: {
        sources: [{ sourceId: "x.yaml", text: text("SELECT p.id, i.id AS item FROM people p JOIN items i ON true") }],
      },
    });
    if (!result.ok) throw Error(JSON.stringify(result.diagnostics));
    // a caller's read keeps only its own rows on both sides of the pairing
    const p = target === "bun-postgres" ? "$1" : "?1";
    expect(result.files["generated.ts"]).toContain(
      `FROM people WHERE people.owner = ${p} ) AS p JOIN ( SELECT id, version, created_at, updated_at, author_id, label FROM items WHERE items.owner = ${p} ) AS i ON`,
    );
    if (target !== "bun-sqlite") continue;
    const dir = await mkdtemp(join(tmpdir(), "mantle-pairs-")),
      db = new Database(":memory:");
    try {
      await writeGenerated(dir, result.files);
      db.exec(result.files["schema.sql"]!);
      for (const table of ["people", "items"])
        for (const [id, owner] of [
          ["1", "a"],
          ["2", "a"],
          ["3", "b"],
        ] as const)
          db.query(`INSERT INTO ${table}(id,version,created_at,updated_at,owner,label) VALUES (?,1,0,0,?,'x')`).run(
            id,
            owner,
          );
      const { default: pairs } = await import(join(dir, "views/pairs.ts"));
      const rows = (await pairs(db, userCaller({ id: "a" }, {}), {})) as { id: string; item: string }[];
      expect(rows.map(r => `${r.id}x${r.item}`).sort()).toEqual(["1x1", "1x2", "2x1", "2x2"]);
    } finally {
      db.close();
      await rm(dir, { recursive: true, force: true });
    }
  }
});

test("date and timestamp literals that do not exist are refused at generate, as request input is", async () => {
  // The compiler checks literals with the request-time scalars; the refusal keeps the compiler's SQL_TYPE code and wording.
  for (const target of ["bun-sqlite", "bun-postgres"] as const)
    for (const [literal, message] of [
      ["'2026-13-01'::date", "'2026-13-01' is not a valid date"],
      ["'2026-02-30'::date", "'2026-02-30' is not a valid date"],
      ["'x'::date", "'x' is not a date"],
      ["'2026-10-11T24:00:00Z'::timestamptz", "'2026-10-11T24:00:00Z' is not a timestamp with an explicit offset"],
      ["'2026-13-01T00:00:00Z'::timestamptz", "'2026-13-01' is not a valid date"],
    ] as const) {
      const text = [
        ...base,
        doc("View", "dated", { surface: "internal", sql: `SELECT id, ${literal} AS at FROM notes` }),
      ].join("\n---\n");
      const result = await generateFromSources({ target, sources: { sources: [{ sourceId: "refused.yaml", text }] } });
      expect(result.ok, `${target} ${literal}`).toBe(false);
      if (!result.ok)
        expect(result.diagnostics).toEqual([
          {
            code: "GENERATE_UNSUPPORTED",
            path: "views/dated",
            message: `This View's caller SQL could not be lowered: ${message}`,
          },
        ]);
      const dialect = target === "bun-postgres" ? postgresDialect() : d1Dialect;
      const compiled = await compilePlan({ sources: [{ sourceId: "refused.yaml", text }] }, dialect, "operational");
      if (!compiled.ok) throw Error(JSON.stringify(compiled.diagnostics));
      const view = compiled.plan.views["dated"]!;
      expect(() =>
        compileProgram(view.stmts, {
          dialect,
          schemas: compiled.plan.schemas,
          inputs: view.inputs,
          kind: "view",
          mode: "caller",
        }),
      ).toThrow(expect.objectContaining({ code: "SQL_TYPE", message }));
    }
});
