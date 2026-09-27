import { describe, expect, it } from "vitest";
import { validateManifests } from "./parse.js";
import { parseManifests } from "./parse.js";
import type {
  Manifest,
  ProcedureManifest,
  SchemaManifest,
  TriggerManifest,
  ViewManifest,
} from "../../src/spec/domain/model/ManifestGrammar.js";

/**
 * Tests for the Loop-1 validate check + the structural parse layer it
 * depends on. The check function is the library-level entry; consumer
 * test harnesses are expected to call it directly with parsed
 * manifests, so most cases here exercise that surface. INVALID_MANIFEST_ENVELOPE
 * is parser-emitted (it surfaces in the CLI when parseManifests
 * throws), so its test goes through parseManifests.
 */

const apiVersion = "cms.mantle.aotter.net/v2" as const;

function schema(
  name: string,
  overrides: Partial<SchemaManifest["spec"]> = {},
): SchemaManifest {
  return {
    apiVersion,
    kind: "Schema",
    metadata: { name },
    spec: {
      title: name,
      schema: {
        type: "object",
        properties: { slug: { type: "string" } },
      },
      ...overrides,
    },
  };
}

function view(
  name: string,
  from: string,
  overrides: Partial<ViewManifest["spec"]> = {},
): ViewManifest {
  return {
    apiVersion,
    kind: "View",
    metadata: { name },
    spec: { surface: "public", select: { from }, ...overrides },
  };
}

function procedure(
  name: string,
  overrides: Partial<ProcedureManifest["spec"]> = {},
): ProcedureManifest {
  return {
    apiVersion,
    kind: "Procedure",
    metadata: { name },
    spec: {
      input: { type: "object" },
      output: { type: "object" },
      handler: { ref: name },
      ...overrides,
    },
  };
}

function trigger(name: string, procedureName: string): TriggerManifest {
  return {
    apiVersion,
    kind: "Trigger",
    metadata: { name },
    spec: {
      source: { kind: "http", method: "POST", path: `/api/${name}` },
      target: { procedure: procedureName },
    },
  };
}

describe("validateManifests()", () => {
  it("accepts a Store-backed View select and checks its Schema columns", () => {
    const select = view("by-slug", "posts", {
      input: { type: "object", properties: { slug: { type: "string" } }, required: ["slug"] },
      select: { from: "posts", columns: ["id", "slug"], where: { slug: "$input.slug" }, orderBy: { id: "asc" }, limit: 10 },
    });
    expect(validateManifests({ manifests: [schema("posts"), select] }).errorCount).toBe(0);
    for (const columns of [["slug"], ["id"]]) {
      const orderBy = columns.includes("id") ? { slug: "asc" as const } : { id: "asc" as const };
      expect(validateManifests({ manifests: [schema("posts"), { ...select, spec: { ...select.spec, select: { ...select.spec.select!, columns, orderBy } } }] }).diagnostics.map((d) => d.code))
        .toContain("VIEW_ORDERBY_INVALID");
    }
    expect(validateManifests({ manifests: [schema("posts"), { ...select, spec: { ...select.spec, select: { ...select.spec.select!, columns: ["missing"] } } }] }).diagnostics.map((diagnostic) => diagnostic.code))
      .toContain("VIEW_FIELD_NOT_IN_SCHEMA");
    expect(validateManifests({ manifests: [schema("posts", { schema: { type: "object", properties: { slug: { type: "string" }, tags: { type: "array", items: { type: "string" } } } } }), { ...select, spec: { ...select.spec, select: { ...select.spec.select!, orderBy: { tags: "asc" } } } }] }).diagnostics.map((diagnostic) => diagnostic.code))
      .toContain("VIEW_FIELD_NOT_IN_SCHEMA");
    expect(validateManifests({ manifests: [schema("posts"), { ...select, spec: { ...select.spec, select: { ...select.spec.select!, where: { slug: "$input.undeclared" } } } }] }).errorCount).toBeGreaterThan(0);
    for (const input of [
      { type: "object" as const, properties: { slug: { type: "string" as const } } },
      { type: "object" as const, properties: { slug: { type: "object" as const } }, required: ["slug"] },
    ]) {
      expect(validateManifests({ manifests: [schema("posts"), { ...select, spec: { ...select.spec, input } }] }).errorCount).toBeGreaterThan(0);
    }
  });

  it("requires a required indexed string scope and ctx.user on a View over it", () => {
    const scoped = schema("sessions", {
      schema: { type: "object", properties: { ownerId: { type: "string" }, slug: { type: "string" } }, required: ["ownerId"] },
      indexes: [["ownerId"]], scope: { ownerId: "$ctx.user.id" },
    });
    expect(validateManifests({ manifests: [scoped] }).errorCount).toBe(0);
    for (const spec of [
      { ...scoped.spec, indexes: [] },
      { ...scoped.spec, scope: { ownerId: "$input.ownerId" } },
      { ...scoped.spec, schema: { ...scoped.spec.schema, properties: { ownerId: { type: "string", "x-mantle-bind": "ctx.staff" } } } },
      { ...scoped.spec, uniqueIndexes: [["slug"]] },
    ]) {
      expect(validateManifests({ manifests: [{ ...scoped, spec } as SchemaManifest] }).errorCount).toBeGreaterThan(0);
    }
    // v2: the Store injects the scope predicate, so a View over a scoped
    // Schema needs no scope filter of its own, only an authenticated caller.
    const selected = view("own-select", "sessions");
    expect(validateManifests({ manifests: [scoped, selected] }).diagnostics.map((d) => d.code))
      .toContain("STORE_CALLER_REQUIRED");
    expect(validateManifests({ manifests: [scoped, { ...selected, spec: { ...selected.spec, requires: { auth: { all: ["ctx.user"] } } } }] }).errorCount).toBe(0);
    const subquery = view("scoped-subquery", "posts", { select: {
      from: "posts", where: { id: { in: { select: "id", from: "sessions" } } },
    } });
    expect(validateManifests({ manifests: [schema("posts"), scoped, subquery] }).diagnostics.map((d) => d.code))
      .toContain("STORE_CALLER_REQUIRED");
    // An `or` cannot widen past the injected scope, so it is no longer a bypass.
    expect(validateManifests({ manifests: [scoped, view("or-widen", "sessions", {
      requires: { auth: { all: ["ctx.user"] } },
      select: { from: "sessions", where: { or: [{ ownerId: "$ctx.user.id" }, { ownerId: "other" }] } },
    })] }).errorCount).toBe(0);
    const own = view("own", "sessions", {
      requires: { auth: { all: ["ctx.user"] } },
      select: { from: "sessions", where: { ownerId: "$ctx.user.id" } },
    });
    expect(validateManifests({ manifests: [scoped, own] }).errorCount).toBe(0);
  });
  it("accepts top-level date-time TTL and rejects unsafe native Views", () => {
    const expiring = schema("events", { schema: { type: "object", properties: {
      expiresAt: { type: "string", format: "date-time", nullable: true },
    } }, ttl: { field: "expiresAt", expireAfterSeconds: 0 } });
    expect(validateManifests({ manifests: [expiring, view("current", "events")] }).errorCount).toBe(0);
    expect(validateManifests({ manifests: [expiring, view("raw", "events", { select: undefined, sql: "SELECT * FROM events" })] })
      .diagnostics.map((d) => d.code)).toContain("VIEW_TTL_NATIVE_UNSAFE");
    const cached = view("cached", "posts", { cache: { sharedMaxAge: 60 }, select: {
      from: "posts", where: { id: { in: { select: "id", from: "events" } } },
    } });
    expect(validateManifests({ manifests: [schema("posts"), expiring, cached] }).diagnostics.map((d) => d.code))
      .toContain("VIEW_CACHE_INVALID");
    expect(validateManifests({ manifests: [schema("posts"), { ...cached, spec: { ...cached.spec, select: {
      from: "posts", where: { version: { lt: "$now" } },
    } } }] }).diagnostics.map((d) => d.code)).toContain("VIEW_CACHE_INVALID");
    // v2: Admin searchFields/filterFields compile onto a select View.
    expect(validateManifests({ manifests: [schema("posts"), view("search", "posts", { surface: "staff",
      uiSchema: { list: { searchFields: ["slug"], filterFields: ["slug"] } },
    })] }).diagnostics.map((d) => d.code)).not.toContain("VIEW_UI_INVALID");
    for (const ttl of [{ field: "missing", expireAfterSeconds: 0 }, { field: "expiresAt", expireAfterSeconds: -1 }]) {
      expect(validateManifests({ manifests: [{ ...expiring, spec: { ...expiring.spec, ttl } }] })
        .diagnostics.map((d) => d.code)).toContain("SCHEMA_TTL_INVALID");
    }
  });
  it("rejects only the native SQL Views that read a TTL Schema's table", () => {
    const expiring = schema("events", { schema: { type: "object", properties: {
      expiresAt: { type: "string", format: "date-time", nullable: true },
    } }, ttl: { field: "expiresAt", expireAfterSeconds: 0 } });
    const codes = (sql: string) => validateManifests({ manifests: [expiring, schema("posts"),
      view("raw", "posts", { select: undefined, sql })] }).diagnostics.map((d) => d.code);
    // SQL over other tables keeps working when some Schema has TTL.
    expect(codes("SELECT * FROM posts")).not.toContain("VIEW_TTL_NATIVE_UNSAFE");
    expect(codes("SELECT * FROM posts_events_archive")).not.toContain("VIEW_TTL_NATIVE_UNSAFE");
    for (const sql of ['SELECT * FROM "events"', "SELECT p.* FROM posts p JOIN Events e ON e.id = p.id", "SELECT * FROM [events]"]) {
      expect(codes(sql)).toContain("VIEW_TTL_NATIVE_UNSAFE");
    }
  });
  it("returns no error diagnostics for a valid manifest set", () => {
    const manifests: Manifest[] = [
      schema("posts"),
      view("postList", "posts"),
      procedure("createPost"),
      trigger("createPostHttp", "createPost"),
    ];
    const result = validateManifests({ manifests });
    expect(result.errorCount).toBe(0);
    expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  });

  it("validates comparison filter field references against the source Schema", () => {
    const result = validateManifests({
      manifests: [
        schema("products", {
          schema: {
            type: "object",
            properties: {
              currentStock: { type: "integer" },
            },
          },
        }),
        view("belowSafetyStock", "products", {
          select: { from: "products", where: { safetyStock: { lte: 10 } } },
        }),
      ],
    });

    const diagnostic = result.diagnostics.find(
      (d) => d.code === "VIEW_FIELD_NOT_IN_SCHEMA",
    );
    expect(diagnostic?.path).toContain("/spec/select/where/safetyStock");
    expect(diagnostic?.value).toBe("safetyStock");
  });

  it("emits TRIGGER_PATH_INVALID when an http Trigger path does not start with /api/", () => {
    const t: TriggerManifest = {
      apiVersion,
      kind: "Trigger",
      metadata: { name: "restockProductHttp" },
      spec: {
        source: { kind: "http", method: "POST", path: "/staff/api/restock" },
        target: { procedure: "restockProduct" },
      },
    };
    const manifests: Manifest[] = [
      schema("posts"),
      procedure("restockProduct"),
      t,
    ];
    const result = validateManifests({ manifests });
    const codes = result.diagnostics.map((d) => d.code);
    expect(codes).toContain("TRIGGER_PATH_INVALID");
    expect(result.errorCount).toBeGreaterThan(0);
  });

  it("does NOT emit a spurious TRIGGER_PATH_COLLISION when two triggers share an invalid path", () => {
    const tA: TriggerManifest = {
      apiVersion,
      kind: "Trigger",
      metadata: { name: "badA" },
      spec: {
        source: { kind: "http", method: "POST", path: "/bad/path" },
        target: { procedure: "restockProduct" },
      },
    };
    const tB: TriggerManifest = {
      apiVersion,
      kind: "Trigger",
      metadata: { name: "badB" },
      spec: {
        source: { kind: "http", method: "POST", path: "/bad/path" },
        target: { procedure: "restockProduct" },
      },
    };
    const manifests: Manifest[] = [
      schema("posts"),
      procedure("restockProduct"),
      tA,
      tB,
    ];
    const result = validateManifests({ manifests });
    const codes = result.diagnostics.map((d) => d.code);
    // Both triggers should report TRIGGER_PATH_INVALID — collision is
    // secondary to the bad prefix and would misdescribe the root cause.
    expect(codes.filter((c) => c === "TRIGGER_PATH_INVALID")).toHaveLength(2);
    expect(codes).not.toContain("TRIGGER_PATH_COLLISION");
  });

  it("emits TRIGGER_TARGET_PROCEDURE_UNKNOWN when a Trigger targets an undeclared Procedure", () => {
    const manifests: Manifest[] = [
      schema("posts"),
      // Note: no Procedure "createPost" declared.
      trigger("createPostHttp", "createPost"),
    ];
    const result = validateManifests({ manifests });
    const codes = result.diagnostics.map((d) => d.code);
    expect(codes).toContain("TRIGGER_TARGET_PROCEDURE_UNKNOWN");
    expect(result.errorCount).toBeGreaterThan(0);
  });

  it("emits VIEW_FROM_UNKNOWN_SCHEMA when a View.from points at an undeclared Schema", () => {
    const manifests: Manifest[] = [
      // No Schema "posts".
      view("postList", "posts"),
    ];
    const result = validateManifests({ manifests });
    const codes = result.diagnostics.map((d) => d.code);
    expect(codes).toContain("VIEW_FROM_UNKNOWN_SCHEMA");
    expect(result.errorCount).toBeGreaterThan(0);
  });

  it("delegates the localized + translates check to checkLocaleAndTranslates", () => {
    // A localized child Schema referencing a non-existent parent should
    // surface TRANSLATES_PARENT_UNKNOWN — proves the delegation hooked up.
    const child: SchemaManifest = {
      apiVersion,
      kind: "Schema",
      metadata: { name: "postContent" },
      spec: {
        title: "Post content",
        schema: {
          type: "object",
          properties: { slug: { type: "string" }, content: { type: "string" } },
        },
        localized: true,
        translates: { parent: "ghost", on: "slug" },
      },
    };
    const result = validateManifests({ manifests: [child] });
    const codes = result.diagnostics.map((d) => d.code);
    expect(codes).toContain("TRANSLATES_PARENT_UNKNOWN");
  });

  it("rejects TTL on either side of a translation join", () => {
    const parent: SchemaManifest = {
      apiVersion, kind: "Schema", metadata: { name: "stories" },
      spec: { title: "Stories", schema: { type: "object", properties: {
        slug: { type: "string" }, expiresAt: { type: "string", format: "date-time" },
      } }, ttl: { field: "expiresAt", expireAfterSeconds: 0 } },
    };
    const child: SchemaManifest = {
      apiVersion, kind: "Schema", metadata: { name: "story-translations" },
      spec: { title: "Translations", localized: true, translates: { parent: "stories", on: "slug" },
        schema: { type: "object", properties: {
          slug: { type: "string" }, locale: { type: "string" }, title: { type: "string" },
          expiresAt: { type: "string", format: "date-time" },
        } },
      },
    };
    expect(validateManifests({ manifests: [parent, child] }).diagnostics.map((d) => d.code))
      .toContain("SCHEMA_TTL_TRANSLATION_UNSUPPORTED");
    const childWithTtl: SchemaManifest = { ...child, spec: { ...child.spec,
      ttl: { field: "expiresAt", expireAfterSeconds: 0 },
    } };
    const parentWithoutTtl: SchemaManifest = { ...parent, spec: { ...parent.spec, ttl: undefined } };
    expect(validateManifests({ manifests: [parentWithoutTtl, childWithTtl] }).diagnostics.map((d) => d.code))
      .toContain("SCHEMA_TTL_TRANSLATION_UNSUPPORTED");
  });

  it("reports every duplicate including the original (#210 PR12 H1 + PR17 first-copy fix)", () => {
    // Regression history:
    //  - original: `c === 2` (silent on 3rd+ copy)
    //  - PR12: `c >= 2` (flags 2nd, 3rd, 4th — but author still
    //    can't locate the canonical first copy)
    //  - PR17: two-pass — flag every occurrence including the first,
    //    so the author sees every offending position.
    const manifests: Manifest[] = [
      schema("posts"),
      schema("posts"),
      schema("posts"),
      schema("posts"),
      procedure("createPost"),
    ];
    const result = validateManifests({ manifests });
    const dups = result.diagnostics.filter((d) => d.code === "DUPLICATE_NAME");
    expect(dups).toHaveLength(4); // every copy including the original
    // First-occurrence diagnostic mentions ordinal 1, last mentions 4/4.
    expect(dups[0]?.message).toMatch(/occurrence 1 of 4/);
    expect(dups[3]?.message).toMatch(/occurrence 4 of 4/);
  });
});

describe("parseManifests() (envelope-shape errors return diagnostics)", () => {
  it("returns INVALID_MANIFEST_ENVELOPE diagnostic when metadata.name is missing", () => {
    const yaml = `apiVersion: cms.mantle.aotter.net/v2
kind: Schema
metadata: {}
spec:
  title: Posts
  schema:
    type: object
`;
    const result = parseManifests(yaml);
    expect(result.manifests).toHaveLength(0);
    expect(result.diagnostics.map((d) => d.code)).toContain(
      "INVALID_MANIFEST_ENVELOPE",
    );
  });
});

describe("parseManifests() — Schema indexes", () => {
  const parseSchema = (
    indexYaml: string,
    properties = "slug: { type: string }",
    name = "posts",
  ) =>
    parseManifests(`apiVersion: cms.mantle.aotter.net/v2
kind: Schema
metadata: { name: ${name} }
spec:
  title: Posts
  schema:
    type: object
    properties: { ${properties} }
${indexYaml}
`);

  it("accepts and preserves ordered composite indexes", () => {
    const result = parseSchema(
      "  localized: true\n  indexes: [[slug, locale], [locale, slug], [slug]]",
      "slug: { type: string }, locale: { type: [string, 'null'] }",
    );

    expect(result.diagnostics).toEqual([]);
    expect((result.manifests[0] as SchemaManifest).spec.indexes).toEqual([
      ["slug", "locale"],
      ["locale", "slug"],
      ["slug"],
    ]);
  });

  it.each([
    ["outer mapping", "  indexes: { slug: true }", "/spec/indexes"],
    ["outer null", "  indexes: null", "/spec/indexes"],
    ["non-array composite", "  indexes: [slug]", "/spec/indexes/0"],
    ["non-string field", "  indexes: [[slug, 1]]", "/spec/indexes/0/1"],
  ])("rejects %s as INVALID_MANIFEST_ENVELOPE", (_label, declaration, pointer) => {
    const result = parseSchema(declaration);

    expect(result.manifests).toEqual([]);
    expect(result.diagnostics[0]).toMatchObject({
      code: "INVALID_MANIFEST_ENVELOPE",
      path: expect.stringContaining(pointer),
    });
  });

  it("rejects unknown Schema keys", () => {
    const result = parseSchema("  indexedFields: [slug]");

    expect(result.diagnostics[0]).toMatchObject({
      code: "INVALID_MANIFEST_ENVELOPE",
      path: expect.stringContaining("/spec/indexedFields"),
    });
  });

  it("accepts a dot as part of an exact top-level field name", () => {
    const result = parseSchema(
      "  indexes: [['profile.slug']]",
      "'profile.slug': { type: string }",
    );
    expect(result.diagnostics).toEqual([]);
  });

  it("does not interpret a dot as a nested path", () => {
    const result = parseSchema(
      "  indexes: [['profile.slug']]",
      "profile: { type: object, properties: { slug: { type: string } } }",
    );
    expect(result.diagnostics[0]?.code).toBe("SCHEMA_INDEX_FIELD_UNKNOWN");
  });

  it.each([
    ["empty composite", "  indexes: [[]]"],
    ["duplicate field", "  indexes: [[slug, slug]]"],
    ["duplicate tuple", "  indexes: [[slug], [slug]]"],
    ["cross-kind duplicate", "  uniqueIndexes: [[slug]]\n  indexes: [[slug]]"],
    ["native column in uniqueIndexes", "  uniqueIndexes: [[status]]"],
    ["unsafe identifier", "  indexes: [['_slug']]"],
  ])("rejects semantic error: %s", (_label, declaration) => {
    const extra = declaration.includes("_slug")
        ? "slug: { type: string }, _slug: { type: string }"
        : "slug: { type: string }";
    const result = parseSchema(declaration, extra);
    expect(result.diagnostics[0]?.code).toBe("SCHEMA_INDEX_INVALID");
  });

  it("indexes may lead with native entry columns; data properties may not reuse their names (#1008)", () => {
    const accepted = parseSchema("  indexes: [[status, publishedAt], [createdAt], [authorId, updatedAt, id]]", "slug: { type: string }, publishedAt: { type: number }");
    expect(accepted.diagnostics).toEqual([]);
    for (const reserved of ["id", "status", "version", "createdAt", "updatedAt", "authorId"]) {
      const shadowed = parseSchema("", `slug: { type: string }, ${reserved}: { type: string }`);
      expect(shadowed.diagnostics[0]).toMatchObject({
        code: "INVALID_MANIFEST_ENVELOPE",
        path: expect.stringContaining(`/spec/schema/properties/${reserved}`),
      });
    }
  });

  it("accepts native entry columns as list columns but not as the primaryField (#1008 follow-up)", () => {
    const ui = (list: string) => parseSchema(`  lifecycle: operational\n  uiSchema:\n    list:\n${list}`, "slug: { type: string }");
    expect(ui("      primaryField: slug\n      columns: [createdAt, updatedAt, status]").diagnostics).toEqual([]);
    expect(ui("      primaryField: createdAt\n      columns: [slug]").diagnostics[0]).toMatchObject({
      code: "SCHEMA_UI_INVALID",
      path: expect.stringContaining("/spec/uiSchema/list/primaryField"),
    });
    expect(ui("      primaryField: slug\n      columns: [nope]").diagnostics[0]?.code).toBe("SCHEMA_UI_INVALID");
  });

  it("preserves the legacy unique unknown-field diagnostic code", () => {
    const result = parseSchema("  uniqueIndexes: [[missing]]");
    expect(result.diagnostics[0]?.code).toBe("UNIQUE_INDEX_FIELD_UNKNOWN");
  });

  it("rejects an unsafe name only when the Schema declares indexes", () => {
    const checked = parseSchema(
      "  indexes: [[slug]]",
      "slug: { type: string }",
      "account/members",
    );

    expect(checked.diagnostics[0]).toMatchObject({
      code: "SCHEMA_INDEX_INVALID",
      path: expect.stringContaining("/metadata/name"),
    });
    expect(parseSchema("", "slug: { type: string }", "account/members").diagnostics)
      .toEqual([]);
  });
});

describe("Schema searchableFields", () => {
  it("accepts top-level string fields and preserves their order", () => {
    const result = parseManifests(`apiVersion: cms.mantle.aotter.net/v2
kind: Schema
metadata: { name: orders }
spec:
  title: Orders
  schema:
    type: object
    properties:
      orderNumber: { type: string }
      customer: { type: [string, 'null'] }
      placedAt: { type: integer }
  searchableFields: [orderNumber, customer]
`);

    expect(result.diagnostics).toEqual([]);
    expect((result.manifests[0] as SchemaManifest).spec.searchableFields)
      .toEqual(["orderNumber", "customer"]);
  });

  it.each([
    ["non-array", "orderNumber", "INVALID_MANIFEST_ENVELOPE"],
    ["unknown field", "[missing]", "SCHEMA_SEARCH_FIELD_UNKNOWN"],
    ["non-string property", "[placedAt]", "SCHEMA_SEARCH_INVALID"],
    ["duplicate field", "[orderNumber, orderNumber]", "SCHEMA_SEARCH_INVALID"],
  ])("rejects %s", (_label, searchableFields, code) => {
    const result = parseManifests(`apiVersion: cms.mantle.aotter.net/v2
kind: Schema
metadata: { name: orders }
spec:
  title: Orders
  schema:
    type: object
    properties:
      orderNumber: { type: string }
      placedAt: { type: integer }
  searchableFields: ${searchableFields}
`);

    expect(result.diagnostics[0]?.code).toBe(code);
  });

});

describe("Schema uiSchema list filter", () => {
  const yaml = (filterField: string, index = "[orderState, placedAt]") => `apiVersion: cms.mantle.aotter.net/v2
kind: Schema
metadata: { name: orders }
spec:
  title: Orders
  lifecycle: operational
  schema:
    type: object
    properties:
      orderState: { type: string, enum: [pending, paid] }
      placedAt: { type: integer }
  indexes: [${index}]
  uiSchema:
    list:
      filterField: ${filterField}
      primaryField: orderState
      columns: [placedAt]
`;

  it("accepts one indexed string-enum field", () => {
    expect(parseManifests(yaml("orderState")).diagnostics).toEqual([]);
  });

  it("accepts an array property as a list column", () => {
    const source = yaml("orderState")
      .replace("placedAt: { type: integer }", "placedAt: { type: integer }\n      interests: { type: array, items: { type: string } }")
      .replace("columns: [placedAt]", "columns: [placedAt, interests]");
    expect(parseManifests(source).diagnostics).toEqual([]);
  });

  it.each([
    ["unknown", "missing", "[orderState, placedAt]"],
    ["not an enum", "placedAt", "[placedAt]"],
    ["not a left-prefix index", "orderState", "[placedAt, orderState]"],
  ])("rejects %s", (_label, field, index) => {
    expect(parseManifests(yaml(field, index)).diagnostics[0]?.code).toBe("SCHEMA_UI_INVALID");
  });

  it("rejects list filters on publishing collections", () => {
    expect(parseManifests(yaml("orderState").replace("lifecycle: operational", "lifecycle: publishing"))
      .diagnostics[0]?.code).toBe("SCHEMA_UI_INVALID");
  });

  it.each([
    ["unknown field", "primaryField: missing\n      columns: [placedAt]"],
    ["duplicate field", "primaryField: orderState\n      columns: [orderState]"],
    ["non-scalar primary field", "primaryField: details\n      columns: [placedAt]"],
  ])("rejects %s in list presentation", (label, listFields) => {
    let source = yaml("orderState").replace(
      "primaryField: orderState\n      columns: [placedAt]",
      listFields,
    );
    if (label === "non-scalar primary field") {
      source = source.replace(
        "placedAt: { type: integer }",
        "placedAt: { type: integer }\n      details: { type: object }",
      );
    }
    expect(parseManifests(source).diagnostics[0]?.code).toBe("SCHEMA_UI_INVALID");
  });
});

describe("Procedure uiSchema fields", () => {
  it("accepts an explicit textarea without changing the input schema", () => {
    const source = `apiVersion: cms.mantle.aotter.net/v2
kind: Procedure
metadata: { name: adjust-inventory }
spec:
  input:
    type: object
    properties:
      reason: { type: string, maxLength: 500 }
  uiSchema:
    fields:
      reason: { widget: textarea }
  output: { type: object }
  handler: { ref: adjustInventory }
`;
    expect(parseManifests(source).diagnostics).toEqual([]);
  });

  it("accepts a collection action targeting an existing Schema", () => {
    const result = parseManifests(`apiVersion: cms.mantle.aotter.net/v2
kind: Schema
metadata: { name: orders }
spec:
  title: Orders
  schema: { type: object }
---
apiVersion: cms.mantle.aotter.net/v2
kind: Procedure
metadata: { name: create-manual-order }
spec:
  input: { type: object }
  uiSchema: { collectionAction: orders }
  output: { type: object }
  handler: { ref: createManualOrder }
`);
    expect(result.diagnostics).toEqual([]);
  });

  it("rejects a collection action targeting an unknown Schema", () => {
    const parsed = parseManifests(`apiVersion: cms.mantle.aotter.net/v2
kind: Procedure
metadata: { name: create-manual-order }
spec:
  input: { type: object }
  uiSchema: { collectionAction: orders }
  output: { type: object }
  handler: { ref: createManualOrder }
`);
    const result = validateManifests({ manifests: parsed.manifests });
    expect(result.diagnostics[0]).toMatchObject({
      code: "SCHEMA_UI_INVALID",
      path: "/spec/uiSchema/collectionAction",
    });
  });
});

describe("parseManifests() — v0.1.0 promoted grammar", () => {
  it("rejects locale as a property of a non-localized Schema", () => {
    const yaml = `apiVersion: cms.mantle.aotter.net/v2
kind: Schema
metadata: { name: orders }
spec:
  title: Orders
  schema:
    type: object
    properties:
      locale: { type: string }
`;
    expect(parseManifests(yaml).diagnostics[0]).toMatchObject({
      code: "INVALID_MANIFEST_ENVELOPE",
      path: "manifest:doc/0#/spec/schema/properties/locale",
    });
  });

  it("rejects a translation child with no locale-specific payload field", () => {
    const result = parseManifests(`apiVersion: cms.mantle.aotter.net/v2
kind: Schema
metadata: { name: story-translations }
spec:
  title: Story translations
  localized: true
  translates: { parent: stories, on: slug }
  schema:
    type: object
    properties:
      slug: { type: string }
      locale: { type: string }
`);
    expect(result.diagnostics[0]?.code).toBe("TRANSLATES_REQUIRES_CONTENT_FIELD");
  });

  it("rejects translation ownership rules at parse time", () => {
    const source = (localized: string, properties: string) => `apiVersion: cms.mantle.aotter.net/v2
kind: Schema
metadata: { name: story-translations }
spec:
  title: Story translations
  ${localized}
  translates: { parent: stories, on: slug }
  schema:
    type: object
    properties: { ${properties} }
`;

    expect(parseManifests(source("localized: false", "slug: { type: string }, title: { type: string }"))
      .diagnostics[0]?.code).toBe("TRANSLATES_REQUIRES_LOCALIZED");
    expect(parseManifests(source("localized: true", "title: { type: string }"))
      .diagnostics[0]?.code).toBe("TRANSLATES_FIELD_NOT_IN_CHILD");
  });

  it("accepts an inline Store program handler", () => {
    const yaml = `apiVersion: cms.mantle.aotter.net/v2
kind: Procedure
metadata: { name: createPost }
spec:
  input: { type: object, properties: { slug: { type: string } } }
  output: { type: object }
  handler:
    store:
      - { insert: posts, values: $input }
`;
    const result = parseManifests(yaml);
    expect(result.diagnostics).toEqual([]);
    expect(result.manifests).toHaveLength(1);
    const proc = result.manifests[0] as ProcedureManifest;
    expect(proc.spec.handler).toEqual({ store: [{ insert: "posts", values: "$input" }] });
  });

  it("rejects a store handler that also declares ref (mutually exclusive)", () => {
    const yaml = `apiVersion: cms.mantle.aotter.net/v2
kind: Procedure
metadata: { name: createPost }
spec:
  input: { type: object }
  output: { type: object }
  handler:
    store:
      - { insert: posts, values: $input }
    ref: createPost
`;
    const result = parseManifests(yaml);
    expect(result.diagnostics.map((d) => d.code)).toContain("INVALID_MANIFEST_ENVELOPE");
    const v1 = parseManifests(yaml.replace(/  handler:[\s\S]*$/, "  handler: { kind: builtin, op: create, schema: posts }\n"));
    expect(v1.diagnostics.map((d) => d.code)).toContain("INVALID_MANIFEST_ENVELOPE");
  });

  it("accepts Trigger.source.kind: 'lifecycle' with on + schema", () => {
    const yaml = `apiVersion: cms.mantle.aotter.net/v2
kind: Trigger
metadata: { name: postsCaptcha }
spec:
  source:
    kind: lifecycle
    schema: posts
    on: [before_create]
  target: { procedure: captchaCheck }
`;
    const result = parseManifests(yaml);
    expect(result.diagnostics).toEqual([]);
    expect(result.manifests).toHaveLength(1);
    const trig = result.manifests[0] as TriggerManifest;
    expect(trig.spec.source.kind).toBe("lifecycle");
  });

  it("accepts Cloudflare schedules and rejects malformed cron, required input, and user authorization", () => {
    const procedure = {
      apiVersion, kind: "Procedure", metadata: { name: "sweep" },
      spec: { input: { type: "object", properties: {} }, output: { type: "object" }, handler: { ref: "sweep" } },
    } as ProcedureManifest;
    const trigger = {
      apiVersion, kind: "Trigger", metadata: { name: "daily-sweep" },
      spec: { source: { kind: "schedule", cron: "0 2 * * *", enabled: true }, target: { procedure: "sweep" } },
    } as TriggerManifest;
    expect(validateManifests({ manifests: [procedure, trigger] }).diagnostics.map((d) => d.code)).not.toContain("SCHEDULE_INPUT_INVALID");
    expect(validateManifests({ manifests: [{ ...procedure, spec: { ...procedure.spec,
      input: { type: "object", required: ["token"], properties: { token: { type: "string" } } },
    } }, trigger] }).diagnostics.map((d) => d.code)).toContain("SCHEDULE_INPUT_INVALID");
    expect(validateManifests({ manifests: [{ ...procedure, spec: { ...procedure.spec,
      requires: { auth: { all: [{ "ctx.staff": ["owner"] }] } },
    } }, trigger] }).diagnostics.map((d) => d.code)).toContain("SCHEDULE_AUTH_INVALID");
    // POSIX weekday: 0 = Sunday through 6 = Saturday; 7 is out of range.
    expect(parseManifests(JSON.stringify({ ...trigger, spec: { ...trigger.spec,
      source: { kind: "schedule", cron: "0 2 * * 0" },
    } })).diagnostics).toEqual([]);
    for (const cron of ["* * * *", "*/0 * * * *", "60 * * * *", "0 2 31-1 * *", "0  2 * * *", "0 2 * * 7"]) {
      expect(parseManifests(JSON.stringify({ ...trigger, spec: { ...trigger.spec,
        source: { kind: "schedule", cron },
      } })).diagnostics.map((d) => d.code)).toContain("INVALID_MANIFEST_ENVELOPE");
    }
  });

  it("rejects the removed v1 lifecycle errorPolicy key", () => {
    const yaml = `apiVersion: cms.mantle.aotter.net/v2
kind: Trigger
metadata: { name: postsNotify }
spec:
  source:
    kind: lifecycle
    schema: posts
    on: [before_create]
    errorPolicy: abort
  target: { procedure: notifySlack }
`;
    const result = parseManifests(yaml);
    expect(result.diagnostics[0]).toMatchObject({
      code: "INVALID_MANIFEST_ENVELOPE",
      path: expect.stringContaining("/spec/source/errorPolicy"),
    });
  });

  it("accepts Trigger.source.kind: 'mcp' with surface: staff (#281 promotion)", () => {
    const yaml = `apiVersion: cms.mantle.aotter.net/v2
kind: Trigger
metadata: { name: restockSkuMcp }
spec:
  source:
    kind: mcp
    surface: staff
  target: { procedure: restockSku }
`;
    const result = parseManifests(yaml);
    expect(result.diagnostics).toEqual([]);
    expect(result.manifests).toHaveLength(1);
    const trig = result.manifests[0] as TriggerManifest;
    expect(trig.spec.source.kind).toBe("mcp");
    if (trig.spec.source.kind === "mcp") {
      expect(trig.spec.source.surface).toBe("staff");
    }
  });

  it("accepts Trigger.source.kind: 'mcp' with surface: public", () => {
    const yaml = `apiVersion: cms.mantle.aotter.net/v2
kind: Trigger
metadata: { name: lookupPriceMcp }
spec:
  source:
    kind: mcp
    surface: public
  target: { procedure: lookupPrice }
`;
    const result = parseManifests(yaml);
    expect(result.diagnostics).toEqual([]);
  });

  it("rejects Trigger.source.kind: 'mcp' without a surface", () => {
    const yaml = `apiVersion: cms.mantle.aotter.net/v2
kind: Trigger
metadata: { name: bareMcp }
spec:
  source: { kind: mcp }
  target: { procedure: somewhere }
`;
    const result = parseManifests(yaml);
    expect(result.diagnostics.map((d) => d.message).join("\n")).toMatch(
      /surface must be one of/,
    );
  });

  it("rejects Trigger.source.kind: 'mcp' with an unknown surface", () => {
    const yaml = `apiVersion: cms.mantle.aotter.net/v2
kind: Trigger
metadata: { name: wrongSurface }
spec:
  source:
    kind: mcp
    surface: admin
  target: { procedure: x }
`;
    const result = parseManifests(yaml);
    expect(result.diagnostics.map((d) => d.message).join("\n")).toMatch(
      /surface must be one of/,
    );
  });

  it("rejects Trigger.source.kind: 'mcp' mixed with lifecycle keys (schema/on)", () => {
    const yaml = `apiVersion: cms.mantle.aotter.net/v2
kind: Trigger
metadata: { name: mixedLifecycle }
spec:
  source:
    kind: mcp
    surface: staff
    schema: posts
    on: [before_create]
  target: { procedure: bar }
`;
    const result = parseManifests(yaml);
    expect(result.diagnostics[0]).toMatchObject({
      code: "INVALID_MANIFEST_ENVELOPE",
      path: expect.stringContaining("/spec/source/schema"),
    });
  });

  it("rejects Trigger.source.kind: 'mcp' mixed with http keys (method/path)", () => {
    const yaml = `apiVersion: cms.mantle.aotter.net/v2
kind: Trigger
metadata: { name: mixedKeys }
spec:
  source:
    kind: mcp
    surface: staff
    method: POST
    path: /api/foo
  target: { procedure: bar }
`;
    const result = parseManifests(yaml);
    expect(result.diagnostics[0]).toMatchObject({
      code: "INVALID_MANIFEST_ENVELOPE",
      path: expect.stringContaining("/spec/source/method"),
    });
  });
});

describe("parseManifests() — View.requires.auth", () => {
  it("accepts a View with requires.auth.all = [ctx.user]", () => {
    const yaml = `apiVersion: cms.mantle.aotter.net/v2
kind: View
metadata: { name: privatePosts }
spec:
  surface: public
  select: { from: posts }
  requires:
    auth:
      all: [ctx.user]
`;
    const result = parseManifests(yaml);
    expect(result.diagnostics).toEqual([]);
  });

  it("accepts ctx.auth and scalar ctx.auth.scope predicates", () => {
    const yaml = `apiVersion: cms.mantle.aotter.net/v2
kind: View
metadata: { name: scopedPosts }
spec:
  surface: public
  select: { from: posts }
  requires:
    auth:
      all:
        - ctx.auth
        - { "ctx.auth.scope": "posts:read" }
`;
    const result = parseManifests(yaml);
    expect(result.diagnostics).toEqual([]);
    const parsed = result.manifests[0] as ViewManifest;
    expect(parsed.spec.requires?.auth?.all).toEqual([
      "ctx.auth",
      { "ctx.auth.scope": "posts:read" },
    ]);
  });

  it("rejects an empty ctx.auth.scope", () => {
    const yaml = `apiVersion: cms.mantle.aotter.net/v2
kind: View
metadata: { name: scopedPosts }
spec:
  surface: public
  select: { from: posts }
  requires:
    auth:
      all: [{ "ctx.auth.scope": "" }]
`;
    const result = parseManifests(yaml);
    expect(result.diagnostics[0]?.message).toContain("non-empty string");
  });

  it("rejects View.requires.auth.all with a role outside STAFF_ROLES", () => {
    const yaml = `apiVersion: cms.mantle.aotter.net/v2
kind: View
metadata: { name: secretView }
spec:
  surface: public
  select: { from: posts }
  requires:
    auth:
      all: [{ "ctx.staff": ["superadmin"] }]
`;
    const result = parseManifests(yaml);
    expect(result.diagnostics.map((d) => d.code)).toContain("AUTH_PREDICATE_NOT_IN_ENUM");
  });

  it("rejects unsupported View auth keys", () => {
    const yaml = `apiVersion: cms.mantle.aotter.net/v2
kind: View
metadata: { name: vAny }
spec:
  surface: public
  select: { from: posts }
  requires:
    auth:
      any: [ctx.user]
`;
    const result = parseManifests(yaml);
    expect(result.diagnostics.map((d) => d.code)).toContain("INVALID_MANIFEST_ENVELOPE");
  });

  it("rejects extra keys beside a valid auth predicate", () => {
    const yaml = `apiVersion: cms.mantle.aotter.net/v2
kind: View
metadata: { name: mixedPredicate }
spec:
  surface: public
  select: { from: posts }
  requires:
    auth:
      all: [{ "ctx.staff": [editor], owns: posts }]
`;
    const result = parseManifests(yaml);
    expect(result.diagnostics[0]).toMatchObject({
      code: "INVALID_MANIFEST_ENVELOPE",
      path: expect.stringContaining("/spec/requires/auth/all/0/owns"),
    });
  });

  it("rejects View.requires.auth.all with a non-STAFF_ROLES role (parser-level)", () => {
    const yaml = `apiVersion: cms.mantle.aotter.net/v2
kind: View
metadata: { name: vStaff }
spec:
  surface: public
  select: { from: posts }
  requires:
    auth:
      all: [{ "ctx.staff": ["superadmin"] }]
`;
    const result = parseManifests(yaml);
    expect(result.diagnostics.map((d) => d.code)).toContain("AUTH_PREDICATE_NOT_IN_ENUM");
  });
});

describe("View $ctx.user where reference", () => {
  it("accepts only the exact $ctx.user.id caller reference", () => {
    const valid = parseManifests(`apiVersion: cms.mantle.aotter.net/v2
kind: View
metadata: { name: myOrders }
spec:
  surface: public
  select: { from: orders, where: { userId: $ctx.user.id } }
  requires: { auth: { all: [ctx.user] } }
`);
    expect(valid.diagnostics).toEqual([]);

    for (const [where, code] of [
      [`{ userId: $ctx.user.email }`, "STORE_REFERENCE_UNKNOWN"],
      [`{ userId: $ctx.user }`, "STORE_REFERENCE_UNKNOWN"],
      // The v1 Filter AST object sentinel is not a v2 value.
      [`{ userId: { "$ctx.user": id } }`, "INVALID_MANIFEST_ENVELOPE"],
    ] as const) {
      const result = parseManifests(`apiVersion: cms.mantle.aotter.net/v2
kind: View
metadata: { name: myOrders }
spec:
  surface: public
  select: { from: orders, where: ${where} }
  requires: { auth: { all: [ctx.user] } }
`);
      expect(result.diagnostics.map((d) => d.code)).toContain(code);
    }
  });

  it("requires ctx.user auth for a $ctx.user.id reference", () => {
    const orders = schema("orders", {
      schema: {
        type: "object",
        properties: {
          userId: { type: "string" },
          placedAt: { type: "integer" },
        },
      },
    });
    const myOrders = view("myOrders", "orders", {
      select: { from: "orders", where: { userId: "$ctx.user.id" } },
    });
    const missing = validateManifests({ manifests: [orders, myOrders] });
    expect(missing.diagnostics.map((d) => d.code)).toContain("STORE_CALLER_REQUIRED");

    const valid = validateManifests({
      manifests: [
        orders,
        {
          ...myOrders,
          spec: {
            ...myOrders.spec,
            requires: { auth: { all: ["ctx.user"] } },
          },
        },
      ],
    });
    expect(valid.errorCount).toBe(0);
  });
});

describe("requires.guard", () => {
  it("parses the single Procedure guard sub-spec on Procedure and View", () => {
    const yaml = `apiVersion: cms.mantle.aotter.net/v2
kind: Procedure
metadata: { name: guardedWrite }
spec:
  input: { type: object }
  output: { type: object }
  requires: { guard: { procedure: requirePaid } }
  handler: { ref: guardedWrite }
---
apiVersion: cms.mantle.aotter.net/v2
kind: View
metadata: { name: guardedRead }
spec:
  surface: public
  select: { from: posts }
  requires: { guard: { procedure: requirePaid } }
`;
    const result = parseManifests(yaml);
    expect(result.diagnostics).toEqual([]);
  });

  it("rejects guard keys beyond procedure", () => {
    const yaml = `apiVersion: cms.mantle.aotter.net/v2
kind: View
metadata: { name: guardedRead }
spec:
  surface: public
  select: { from: posts }
  requires: { guard: { procedure: requirePaid, cache: true } }
`;
    const result = parseManifests(yaml);
    expect(result.diagnostics[0]?.message).toContain("accepts only `procedure`");
  });

  it("validates missing, self, inline-program, and chained guard targets", () => {
    const missing = procedure("missingTarget", {
      requires: { guard: { procedure: "notThere" } },
    });
    const self = procedure("selfGuard", {
      requires: { guard: { procedure: "selfGuard" } },
    });
    const builtin = procedure("builtinGuard", {
      input: { type: "object", properties: { slug: { type: "string" } } },
      handler: { store: [{ insert: "posts", values: "$input" }] },
    });
    const chained = procedure("chainedGuard", {
      requires: { guard: { procedure: "leafGuard" } },
    });
    const leaf = procedure("leafGuard");
    const targetBuiltin = view("targetBuiltin", "posts", {
      requires: { guard: { procedure: "builtinGuard" } },
    });
    const targetChain = view("targetChain", "posts", {
      requires: { guard: { procedure: "chainedGuard" } },
    });

    const result = validateManifests({
      manifests: [
        schema("posts"),
        missing,
        self,
        builtin,
        chained,
        leaf,
        targetBuiltin,
        targetChain,
      ],
    });
    const codes = result.diagnostics.map((d) => d.code);
    expect(codes).toContain("GUARD_PROCEDURE_UNKNOWN");
    expect(codes).toContain("GUARD_SELF_REFERENCE");
    expect(codes).toContain("GUARD_PROCEDURE_NOT_REF");
    expect(codes).toContain("GUARD_CHAIN_NOT_ALLOWED");
  });
});

describe("parseManifests() — View.spec.surface (#433)", () => {
  it("accepts a bounded shared cache on an unguarded public View", () => {
    const result = parseManifests(`apiVersion: cms.mantle.aotter.net/v2
kind: View
metadata: { name: cachedPosts }
spec:
  select: { from: posts }
  surface: public
  cache: { sharedMaxAge: 3600 }
`);
    expect(result.diagnostics).toEqual([]);
    expect((result.manifests[0] as ViewManifest).spec.cache).toEqual({ sharedMaxAge: 3600 });
  });

  it.each([
    ["staff", "surface: staff\n  select: { from: posts }"],
    ["guarded", "surface: public\n  select: { from: posts }\n  requires: can-read"],
    ["SQL", "surface: public\n  sql: SELECT * FROM posts"],
  ])("rejects shared cache on a %s View", (_case, body) => {
    const result = parseManifests(`apiVersion: cms.mantle.aotter.net/v2
kind: View
metadata: { name: unsafeCache }
spec:
  ${body}
  cache: { sharedMaxAge: 60 }
`);
    expect(result.diagnostics[0]?.code).toBe("VIEW_CACHE_INVALID");
  });

  it("rejects shared cache outside the supported TTL range", () => {
    const result = parseManifests(`apiVersion: cms.mantle.aotter.net/v2
kind: View
metadata: { name: cachedPosts }
spec:
  select: { from: posts }
  surface: public
  cache: { sharedMaxAge: 86401 }
`);
    expect(result.diagnostics[0]?.code).toBe("VIEW_CACHE_INVALID");
  });

  it.each(["null", "[]", "{ sharedMaxAge: 0 }", "{ sharedMaxAge: 1.5 }"])(
    "rejects invalid shared cache value %s",
    (cache) => {
      const result = parseManifests(`apiVersion: cms.mantle.aotter.net/v2
kind: View
metadata: { name: cachedPosts }
spec:
  select: { from: posts }
  surface: public
  cache: ${cache}
`);
      expect(result.diagnostics.length).toBeGreaterThan(0);
    },
  );

  it("rejects unknown shared cache keys", () => {
    const result = parseManifests(`apiVersion: cms.mantle.aotter.net/v2
kind: View
metadata: { name: cachedPosts }
spec:
  select: { from: posts }
  surface: public
  cache: { sharedMaxAge: 60, staleWhileRevalidate: 30 }
`);
    expect(result.diagnostics.length).toBeGreaterThan(0);
  });

  it("rejects a public View over a publishing Schema that compares status to anything but published (#1007)", () => {
    const codes = (where: NonNullable<ViewManifest["spec"]["select"]>["where"]) => validateManifests({
      manifests: [schema("posts"), view("posts-by-status", "posts", { select: { from: "posts", where } })],
    }).diagnostics.map((diagnostic) => diagnostic.code);
    expect(codes({ status: "draft" })).toContain("VIEW_PUBLIC_STATUS_INVALID");
    expect(codes({ and: [{ slug: "a" }, { status: { gt: "a" } }] })).toContain("VIEW_PUBLIC_STATUS_INVALID");
    expect(codes({ status: "published" })).not.toContain("VIEW_PUBLIC_STATUS_INVALID");
    expect(codes(undefined)).not.toContain("VIEW_PUBLIC_STATUS_INVALID");
    expect(validateManifests({
      manifests: [
        schema("orders", { schema: { type: "object", properties: { status: { type: "string" } } } }),
        view("orders-public", "orders"),
      ],
    }).diagnostics.map((diagnostic) => diagnostic.code)).toContain("INVALID_MANIFEST_ENVELOPE"); // a data `status` is rejected at parse (#1008)
    expect(validateManifests({
      manifests: [
        schema("posts"),
        view("all-posts", "posts", { surface: "staff", select: { from: "posts", where: { status: "draft" } } }),
        schema("orders", { lifecycle: "operational" }),
        view("open-orders", "orders", { select: { from: "orders", where: { status: "draft" } } }),
      ],
    }).diagnostics.map((diagnostic) => diagnostic.code)).not.toContain("VIEW_PUBLIC_STATUS_INVALID");
  });

  it("rejects shared cache over an operational Schema", () => {
    const result = validateManifests({
      manifests: [
        schema("sessions", { lifecycle: "operational" }),
        view("cachedSessions", "sessions", { cache: { sharedMaxAge: 60 } }),
      ],
    });
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain("VIEW_CACHE_INVALID");
  });

  it("rejects shared cache on an identity-bound View", () => {
    const result = validateManifests({
      manifests: [
        schema("accounts", { indexes: [["ownerId"]], schema: {
          type: "object",
          properties: { ownerId: { type: "string" } },
        } }),
        view("myAccount", "accounts", {
          cache: { sharedMaxAge: 60 },
          select: { from: "accounts", where: { ownerId: "$ctx.user.id" } },
        }),
      ],
    });
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain("VIEW_CACHE_INVALID");
  });

  it("accepts surface: public", () => {
    const yaml = `apiVersion: cms.mantle.aotter.net/v2
kind: View
metadata: { name: publicView }
spec:
  select: { from: posts }
  surface: public
`;
    const result = parseManifests(yaml);
    expect(result.diagnostics).toEqual([]);
    const view = result.manifests[0] as ViewManifest;
    expect(view.spec.surface).toBe("public");
  });

  it("accepts surface: staff", () => {
    const yaml = `apiVersion: cms.mantle.aotter.net/v2
kind: View
metadata: { name: staffView }
spec:
  select: { from: posts }
  surface: staff
`;
    const result = parseManifests(yaml);
    expect(result.diagnostics).toEqual([]);
    const view = result.manifests[0] as ViewManifest;
    expect(view.spec.surface).toBe("staff");
  });

  it("accepts surface: internal and rejects shared caching", () => {
    const yaml = `apiVersion: cms.mantle.aotter.net/v2
kind: View
metadata: { name: internalView }
spec:
  select: { from: posts }
  surface: internal
`;
    expect(parseManifests(yaml).diagnostics).toEqual([]);
    expect(parseManifests(`${yaml}  cache: { sharedMaxAge: 60 }\n`).diagnostics)
      .toEqual([expect.objectContaining({
        code: "VIEW_CACHE_INVALID",
        source: expect.objectContaining({ path: "/spec/cache" }),
      })]);
  });

  it("does not reserve MCP tool names for internal Views", () => {
    expect(parseManifests(`apiVersion: cms.mantle.aotter.net/v2
kind: View
metadata: { name: report-a }
spec: { surface: internal, sql: SELECT 1 }
---
apiVersion: cms.mantle.aotter.net/v2
kind: View
metadata: { name: report_a }
spec: { surface: internal, sql: SELECT 2 }
`).diagnostics).toEqual([]);
  });

  it("accepts the minimal staff View Admin list uiSchema", () => {
    const result = parseManifests(`apiVersion: cms.mantle.aotter.net/v2
kind: View
metadata: { name: staffView }
spec:
  select: { from: posts }
  surface: staff
  uiSchema:
    list:
      columns: [id, orderNumber]
      searchFields: [orderNumber]
      filterFields: [orderStatus]
`);
    expect(result.diagnostics).toEqual([]);
    expect((result.manifests[0] as ViewManifest).spec.uiSchema).toMatchObject({
      list: { searchFields: ["orderNumber"], filterFields: ["orderStatus"] },
    });
  });

  it("rejects View Admin uiSchema on the public surface", () => {
    const result = parseManifests(`apiVersion: cms.mantle.aotter.net/v2
kind: View
metadata: { name: publicView }
spec:
  select: { from: posts }
  surface: public
  uiSchema: { list: { searchFields: [slug] } }
`);
    expect(result.diagnostics[0]?.code).toBe("VIEW_UI_INVALID");
  });

  it("rejects an absent surface", () => {
    const yaml = `apiVersion: cms.mantle.aotter.net/v2
kind: View
metadata: { name: defaultView }
spec:
  select: { from: posts }
`;
    const result = parseManifests(yaml);
    expect(result.diagnostics[0]?.message).toMatch(/surface is required/);
  });

  it("rejects an unknown surface string", () => {
    const yaml = `apiVersion: cms.mantle.aotter.net/v2
kind: View
metadata: { name: badView }
spec:
  select: { from: posts }
  surface: admin
`;
    const result = parseManifests(yaml);
    expect(result.diagnostics.map((d) => d.message)).toContainEqual(
      expect.stringMatching(/View\.spec\.surface.*must be one of/),
    );
  });

  it("accepts one bound SELECT and rejects non-read SQL", () => {
    const valid = parseManifests(`apiVersion: cms.mantle.aotter.net/v2
kind: View
metadata: { name: paidOrders }
spec:
  surface: staff
  sql: SELECT * FROM orders WHERE orderStatus = :status
  input:
    type: object
    properties: { status: { type: string } }
    required: [status]
`);
    expect(valid.diagnostics).toEqual([]);

    const invalid = parseManifests(`apiVersion: cms.mantle.aotter.net/v2
kind: View
metadata: { name: bad }
spec:
  surface: staff
  sql: DELETE FROM orders
`);
    expect(invalid.diagnostics[0]?.message).toMatch(/one SELECT/);
  });
});

describe("parseManifests() — YAML alias-bomb regression (#210 H4)", () => {
  it("surfaces an INVALID_MANIFEST_ENVELOPE diagnostic on exponentially-expanding aliases", () => {
    // Deep nested aliases: each level multiplies the expansion 10x.
    // `maxAliasCount: 100` in ManifestParser triggers the yaml lib's
    // bail — the parser now catches that throw and converts it to a
    // structured diagnostic instead of propagating as an uncaught
    // ReferenceError.
    const yaml = `apiVersion: cms.mantle.aotter.net/v2
kind: Schema
metadata: { name: bombed }
spec:
  title: Bombed
  schema:
    type: object
    properties:
      a: &a {x: 1}
      l1: &l1 [*a, *a, *a, *a, *a, *a, *a, *a, *a, *a]
      l2: &l2 [*l1, *l1, *l1, *l1, *l1, *l1, *l1, *l1, *l1, *l1]
      l3: &l3 [*l2, *l2, *l2, *l2, *l2, *l2, *l2, *l2, *l2, *l2]
      l4: &l4 [*l3, *l3, *l3, *l3, *l3, *l3, *l3, *l3, *l3, *l3]
      l5: [*l4, *l4, *l4, *l4, *l4, *l4, *l4, *l4, *l4, *l4]
`;
    const result = parseManifests(yaml);
    expect(result.manifests).toHaveLength(0);
    expect(result.diagnostics.map((d) => d.code)).toContain("INVALID_MANIFEST_ENVELOPE");
    expect(result.diagnostics[0]?.message).toMatch(/alias/i);
  });
});

describe("parseManifests() — View.input + select where reference grammar", () => {
  const acceptYaml = (yaml: string) => {
    const r = parseManifests(yaml);
    expect(r.diagnostics).toEqual([]);
    return r;
  };
  const viewYaml = (body: string) => `apiVersion: cms.mantle.aotter.net/v2
kind: View
metadata: { name: v }
spec:
  surface: public
${body}`;

  it("accepts a View with no input (static query)", () => {
    acceptYaml(viewYaml(`  select:
    from: posts
    where: { status: published }
`));
  });

  it("accepts a View with required input + $input where reference", () => {
    const r = acceptYaml(viewYaml(`  input:
    type: object
    properties:
      locale: { type: string }
    required: [locale]
  select:
    from: posts
    where:
      and:
        - { status: published }
        - { locale: $input.locale }
`));
    const v = r.manifests[0] as ViewManifest;
    expect(v.spec.input?.required).toEqual(["locale"]);
  });

  it("accepts comparison where clauses with literal and $input values", () => {
    acceptYaml(viewYaml(`  input:
    type: object
    properties:
      startAt: { type: string }
      endAt: { type: string }
    required: [startAt, endAt]
  select:
    from: stock-movements
    where:
      and:
        - { occurredAt: { gte: $input.startAt } }
        - { occurredAt: { lt: $input.endAt } }
        - { quantity: { gt: 0 } }
`));
  });

  it("rejects View.spec.input when type !== object", () => {
    const r = parseManifests(viewYaml(`  select: { from: posts }
  input:
    type: string
`));
    expect(r.diagnostics.map((d) => d.code)).toContain("VIEW_INPUT_INVALID_SHAPE");
  });

  it.each(["limit", "cursor"])("rejects View.spec.input with reserved name '%s'", (name) => {
    const r = parseManifests(viewYaml(`  select: { from: posts }
  input:
    type: object
    properties:
      ${name}: { type: string }
    required: [${name}]
`));
    expect(r.diagnostics.map((d) => d.code)).toContain("VIEW_INPUT_RESERVED_NAME");
  });

  it("reserves pagination names on every View and no longer reserves page/show", () => {
    const paged = view("paged", "posts", { input: { type: "object", properties: { page: { type: "integer" }, show: { type: "integer" } } } });
    expect(parseManifests(JSON.stringify(paged)).diagnostics).toEqual([]);
    const sql = { ...paged, spec: { ...paged.spec, select: undefined, sql: "SELECT * FROM posts",
      input: { type: "object", properties: { limit: { type: "integer" } } } } };
    expect(parseManifests(JSON.stringify(sql)).diagnostics.map((d) => d.code)).toContain("VIEW_INPUT_RESERVED_NAME");
  });

  it("rejects an $input reference when the View declares no input", () => {
    const r = parseManifests(viewYaml(`  select:
    from: posts
    where: { locale: $input.locale }
`));
    expect(r.diagnostics.map((d) => d.code)).toContain("STORE_REFERENCE_UNKNOWN");
  });

  it("rejects an $input where reference to an input not in required", () => {
    const r = parseManifests(viewYaml(`  input:
    type: object
    properties:
      locale: { type: string }
  select:
    from: posts
    where: { locale: $input.locale }
`));
    expect(r.diagnostics.map((d) => d.code)).toContain("STORE_REFERENCE_NOT_REQUIRED");
  });

  it("rejects an $input reference naming a property the input schema does not declare", () => {
    const r = parseManifests(viewYaml(`  input:
    type: object
    properties:
      locale: { type: string }
    required: [locale]
  select:
    from: posts
    where: { tag: $input.tag }
`));
    expect(r.diagnostics.map((d) => d.code)).toContain("STORE_REFERENCE_UNKNOWN");
  });

  it("rejects a comparison $input reference to an input not in required", () => {
    const r = parseManifests(viewYaml(`  input:
    type: object
    properties:
      minStock: { type: integer }
  select:
    from: posts
    where: { currentStock: { lt: $input.minStock } }
`));
    expect(r.diagnostics.map((d) => d.code)).toContain("STORE_REFERENCE_NOT_REQUIRED");
  });
});

describe("parseManifests() — ctx.staff role-enum enforcement", () => {
  it("rejects ctx.staff with a role that is not in STAFF_ROLES", () => {
    const yaml = `apiVersion: cms.mantle.aotter.net/v2
kind: Procedure
metadata: { name: secret }
spec:
  input: { type: object }
  output: { type: object }
  requires:
    auth:
      all: [{ "ctx.staff": ["superadmin"] }]
  handler: { ref: secretFn }
`;
    const result = parseManifests(yaml);
    expect(result.diagnostics.map((d) => d.code)).toContain("AUTH_PREDICATE_NOT_IN_ENUM");
  });

  it("accepts ctx.staff with all roles in STAFF_ROLES", () => {
    const yaml = `apiVersion: cms.mantle.aotter.net/v2
kind: Procedure
metadata: { name: editor }
spec:
  input: { type: object }
  output: { type: object }
  requires:
    auth:
      all: [{ "ctx.staff": ["owner", "editor"] }]
  handler: { ref: editorFn }
`;
    const result = parseManifests(yaml);
    expect(result.diagnostics).toEqual([]);
  });
});

/**
 * Tests for `checkHandlerRefsInSource` — the source-grep that pairs
 * `Procedure.handler.ref` with an actual registration in the consumer's
 * `src/`. Two registration patterns are valid evidence:
 *
 *   1. Quoted object key — `handlers: { 'captchaCheck': fn }`.
 *   2. Unquoted object-property key — `{ captchaCheck: fn }`, the
 *      JS shorthand the publication / intake / presence starters use
 *      in `src/handlers/index.ts`'s `buildHandlers()`. Previously this
 *      pattern was missed (false-positive HANDLER_NOT_REGISTERED).
 */
describe("checkHandlerRefsInSource — HANDLER_NOT_REGISTERED", () => {
  const captchaProcedure = procedure("captchaCheck");

  it("accepts a quoted string-literal registration", () => {
    const source = `
      import { register } from "./registry";
      register('captchaCheck', () => true);
    `;
    const result = validateManifests({ manifests: [captchaProcedure], handlerSource: source });
    expect(result.diagnostics.filter((d) => d.code === "HANDLER_NOT_REGISTERED")).toEqual([]);
  });

  it("accepts an unquoted object-property-key registration (the starters' idiom)", () => {
    const source = `
      export function buildHandlers(env) {
        return {
          captchaCheck: cloudflareTurnstileCheck({ secret: env.TURNSTILE_SECRET_KEY }),
          slackNotify: slackNotify,
        };
      }
    `;
    const result = validateManifests({
      manifests: [captchaProcedure, procedure("slackNotify")],
      handlerSource: source,
    });
    expect(result.diagnostics.filter((d) => d.code === "HANDLER_NOT_REGISTERED")).toEqual([]);
  });

  it("emits HANDLER_NOT_REGISTERED when the ref is absent from source entirely", () => {
    const source = `export function buildHandlers() { return {}; }`;
    const result = validateManifests({ manifests: [captchaProcedure], handlerSource: source });
    const diag = result.diagnostics.find((d) => d.code === "HANDLER_NOT_REGISTERED");
    expect(diag?.severity).toBe("warning");
    expect(diag?.value).toBe("captchaCheck");
  });

  it("does not false-positive on a substring match — `captchaCheckHelper` is not `captchaCheck`", () => {
    const source = `const captchaCheckHelper = () => true;`;
    const result = validateManifests({ manifests: [captchaProcedure], handlerSource: source });
    // Substring match would falsely accept this; the property-key regex
    // requires the identifier followed by `:` (an object key) so the
    // bare assignment above does NOT count as registration evidence.
    // The quoted-literal regex also doesn't match. Expect the warning.
    const diag = result.diagnostics.find((d) => d.code === "HANDLER_NOT_REGISTERED");
    expect(diag).toBeDefined();
  });

  it("does not false-positive on a comment that mentions the ref name", () => {
    const source = `
      // captchaCheck lives in handlers.ts — see buildHandlers().
      export function buildHandlers() { return {}; }
    `;
    const result = validateManifests({ manifests: [captchaProcedure], handlerSource: source });
    // Comment is not a property key (no \`:\` follows the word) and not
    // a quoted string. Expect the warning to fire.
    const diag = result.diagnostics.find((d) => d.code === "HANDLER_NOT_REGISTERED");
    expect(diag).toBeDefined();
  });
});

describe("View orderBy direction (#392)", () => {
  const sorted = (orderBy: string) => `apiVersion: cms.mantle.aotter.net/v2
kind: View
metadata: { name: posts-sorted }
spec:
  surface: public
  select:
    from: posts
    orderBy: ${orderBy}
`;

  it("rejects an orderBy direction outside asc/desc at parse time", () => {
    const result = parseManifests(sorted(`{ id: "DESC LIMIT 0 --" }`));
    expect(result.manifests).toHaveLength(0);
    expect(result.diagnostics.map((d) => d.code)).toContain("VIEW_ORDERBY_INVALID");
  });

  it("accepts one asc/desc column and rejects the v1 array form", () => {
    expect(parseManifests(sorted("{ createdAt: desc }")).diagnostics).toEqual([]);
    expect(parseManifests(sorted("{ id: asc }")).diagnostics).toEqual([]);
    for (const orderBy of ["[{ field: createdAt, direction: desc }]", "{ createdAt: desc, id: asc }"]) {
      expect(parseManifests(sorted(orderBy)).diagnostics[0]).toMatchObject({
        path: expect.stringContaining("/spec/select/orderBy"),
      });
    }
  });
});

describe("required field absent from properties (#399)", () => {
  it("flags a required entry not declared in properties", () => {
    const result = parseManifests(`apiVersion: cms.mantle.aotter.net/v2
kind: Schema
metadata: { name: posts }
spec:
  title: Posts
  schema:
    type: object
    properties: { title: { type: string } }
    required: [title, slug]
`);
    const diag = result.diagnostics.find((d) => d.code === "REQUIRED_FIELD_UNKNOWN");
    expect(diag).toBeDefined();
    expect(diag?.value).toBe("slug");
  });
});

describe("uncompilable regex pattern (#395)", () => {
  it("flags a malformed `pattern` at validate time instead of crashing at runtime", () => {
    const result = parseManifests(`apiVersion: cms.mantle.aotter.net/v2
kind: Schema
metadata: { name: posts }
spec:
  title: Posts
  schema:
    type: object
    properties:
      slug: { type: string, pattern: "(unterminated" }
`);
    const diag = result.diagnostics.find((d) => d.code === "INVALID_PATTERN");
    expect(diag).toBeDefined();
  });
});

describe("JSON Schema composition (#752)", () => {
  const procedure = (input: string) => `apiVersion: cms.mantle.aotter.net/v2
kind: Procedure
metadata: { name: composed }
spec:
  input: ${input}
  output: { type: object }
  handler: { ref: composed }
`;

  it("accepts recursive local refs, oneOf, const, and schema-valued additionalProperties", () => {
    const result = parseManifests(procedure(`
    type: object
    $defs:
      node:
        oneOf:
          - { const: null }
          - type: object
            required: [value]
            properties:
              value: { type: string }
              next: { $ref: '#/$defs/node' }
    properties:
      root: { $ref: '#/$defs/node' }
      counts: { type: object, additionalProperties: { type: integer } }
  `));
    expect(result.diagnostics).toEqual([]);
  });

  it.each([
    ["remote refs", `{ $ref: 'https://example.com/schema.json' }`, "JSON_SCHEMA_REF_INVALID"],
    ["unresolved refs", `{ $ref: '#/$defs/missing' }`, "JSON_SCHEMA_REF_INVALID"],
    ["unsupported composition", `{ anyOf: [{ type: string }, { type: number }] }`, "JSON_SCHEMA_UNSUPPORTED"],
  ])("rejects %s with a stable diagnostic", (_label, input, code) => {
    const result = parseManifests(procedure(input));
    expect(result.diagnostics[0]?.code).toBe(code);
  });
});
