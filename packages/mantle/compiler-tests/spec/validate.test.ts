import { describe, expect, it } from "vitest";
import { validateManifests } from "./parse.js";
import { parseManifests } from "./parse.js";
import { jsonSchemaToZod } from "../../src/build/spec/domain/service/JsonSchemaToZod.js";
import type {
  Manifest,
  ProcedureManifest,
  SchemaManifest,
  TriggerManifest,
  ViewManifest,
} from "../../src/build/spec/domain/model/ManifestGrammar.js";

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
  table: string,
  overrides: Partial<ViewManifest["spec"]> = {},
): ViewManifest {
  return {
    apiVersion,
    kind: "View",
    metadata: { name },
    spec: { surface: "public", sql: `SELECT id FROM "${table}"`, ...overrides },
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
  it("refuses a Trigger targeting an undeclared Procedure", () => {
    expect(validateManifests({ manifests: [trigger("missing", "missing")] }).diagnostics)
      .toContainEqual(expect.objectContaining({ code: "TRIGGER_TARGET_PROCEDURE_UNKNOWN" }));
  });


  it("requires scope to bind one required, indexed string field to auth.uid()", () => {
    const scoped = schema("sessions", {
      schema: { type: "object", properties: { ownerId: { type: "string" }, slug: { type: "string" } }, required: ["ownerId"] },
      indexes: [["ownerId"]], scope: "ownerId = auth.uid()",
    });
    expect(validateManifests({ manifests: [scoped] }).errorCount).toBe(0);
    for (const spec of [
      { ...scoped.spec, indexes: [] },
      { ...scoped.spec, scope: { ownerId: "$ctx.user.id" } as never }, // the 0.1.x spelling
      { ...scoped.spec, schema: { ...scoped.spec.schema, properties: { ownerId: { type: "string", "x-mantle-bind": "ctx.admin" } } } },
      { ...scoped.spec, uniqueIndexes: [["slug"]] },
    ]) {
      expect(validateManifests({ manifests: [{ ...scoped, spec } as SchemaManifest] }).errorCount).toBeGreaterThan(0);
    }
  });

  it("accepts top-level date-time TTL; SQL cache eligibility is checked by compilePlan", () => {
    const expiring = schema("events", { schema: { type: "object", properties: {
      expiresAt: { type: "string", format: "date-time", nullable: true },
    } }, ttl: { field: "expiresAt", expireAfterSeconds: 0 } });
    const cache = { cache: { sharedMaxAge: 60 } };
    const codes = (...manifests: Manifest[]) => validateManifests({ manifests }).diagnostics.map((d) => d.code);
    expect(validateManifests({ manifests: [expiring, view("current", "events")] }).errorCount).toBe(0);
    expect(codes(schema("posts"), view("cachedPosts", "posts", cache))).not.toContain("VIEW_CACHE_INVALID");
    expect(codes(expiring, view("cachedEvents", "events", cache))).not.toContain("VIEW_CACHE_INVALID");
    expect(codes(schema("sessions", { lifecycle: "operational" }), view("cachedSessions", "sessions", cache))).not.toContain("VIEW_CACHE_INVALID");
    for (const ttl of [{ field: "missing", expireAfterSeconds: 0 }, { field: "expiresAt", expireAfterSeconds: -1 }]) {
      expect(codes({ ...expiring, spec: { ...expiring.spec, ttl } })).toContain("SCHEMA_TTL_INVALID");
    }
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
    ["status on an operational Schema, which has no status column", "  lifecycle: operational\n  indexes: [[status]]"],
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
    ["date-time string, stored as a number", "[shippedAt]", "SCHEMA_SEARCH_INVALID"],
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
      shippedAt: { type: string, format: date-time }
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

  it("accepts handler { ref } or { sql } and nothing else", () => {
    const parse = (handler: string) => parseManifests(`apiVersion: cms.mantle.aotter.net/v2
kind: Procedure
metadata: { name: createPost }
spec:
  input: { type: object }
  output: { type: object }
  handler: ${handler}
`);
    for (const handler of ["{ ref: createPost }", '{ sql: "INSERT INTO posts (slug) VALUES (input.slug)" }']) {
      expect(parse(handler).diagnostics, handler).toEqual([]);
    }
    for (const handler of ["{ kind: ref, ref: createPost }", "{ kind: builtin, op: create, schema: posts }", "{ ref: a, sql: b }", '{ sql: "" }']) {
      expect(parse(handler).diagnostics.map((d) => d.code), handler).toContain("INVALID_MANIFEST_ENVELOPE");
    }
  });

  // ponytail: one table for the mcp source shape
  it("accepts an mcp source on admin or public, and refuses a missing or unknown surface and foreign keys", () => {
    for (const [surface, extra, refusal] of [
    ["surface: admin", "", undefined],
    ["surface: public", "", undefined],
    ["", "", /surface must be one of/],
    ["surface: unknown", "", /surface must be one of/],
    ["surface: admin", "schema: posts\n    on: [before_create]", "/spec/source/schema"],
    ["surface: admin", "method: POST\n    path: /api/foo", "/spec/source/method"],
  ] as const) {
    const yaml = `apiVersion: cms.mantle.aotter.net/v2
kind: Trigger
metadata: { name: mcpTool }
spec:
  source:
    kind: mcp
    ${surface}
    ${extra}
  target: { procedure: bar }
`;
    const { diagnostics } = parseManifests(yaml);
    if (refusal === undefined) expect(diagnostics).toEqual([]);
    else if (typeof refusal === "string") expect(diagnostics[0]).toMatchObject({ code: "INVALID_MANIFEST_ENVELOPE", path: expect.stringContaining(refusal) });
    else expect(diagnostics.map((d) => d.message).join("\n")).toMatch(refusal);
    }
  });

});

describe("parseManifests() — View.requires.auth", () => {

  it("accepts ctx.auth and scalar ctx.auth.scope predicates", () => {
    const yaml = `apiVersion: cms.mantle.aotter.net/v2
kind: View
metadata: { name: scopedPosts }
spec:
  surface: public
  sql: 'SELECT id FROM "posts"'
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
  sql: 'SELECT id FROM "posts"'
  requires:
    auth:
      all: [{ "ctx.auth.scope": "" }]
`;
    const result = parseManifests(yaml);
    expect(result.diagnostics[0]?.message).toContain("non-empty string");
  });

  it("rejects unsupported View auth keys", () => {
    const yaml = `apiVersion: cms.mantle.aotter.net/v2
kind: View
metadata: { name: vAny }
spec:
  surface: public
  sql: 'SELECT id FROM "posts"'
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
  sql: 'SELECT id FROM "posts"'
  requires:
    auth:
      all: [{ "ctx.auth.scope": "posts:read", owns: posts }]
`;
    const result = parseManifests(yaml);
    expect(result.diagnostics[0]).toMatchObject({
      code: "INVALID_MANIFEST_ENVELOPE",
      path: expect.stringContaining("/spec/requires/auth/all/0/owns"),
    });
  });
});

describe("parseManifests() — View.spec.surface (#433)", () => {
  it("accepts a bounded shared cache on an unguarded public View", () => {
    const result = parseManifests(`apiVersion: cms.mantle.aotter.net/v2
kind: View
metadata: { name: cachedPosts }
spec:
  sql: 'SELECT id FROM "posts"'
  surface: public
  cache: { sharedMaxAge: 3600 }
`);
    expect(result.diagnostics).toEqual([]);
    expect((result.manifests[0] as ViewManifest).spec.cache).toEqual({ sharedMaxAge: 3600 });
  });

  it.each([
    ["admin", "surface: admin\n  sql: SELECT 1"],
    ["guarded", "surface: public\n  sql: SELECT 1\n  requires: can-read"],
    ["restricted", "surface: public\n  sql: SELECT 1\n  restrict: { posts: \"region IN auth.user('region')\" }"],
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
  sql: 'SELECT id FROM "posts"'
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
  sql: 'SELECT id FROM "posts"'
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
  sql: 'SELECT id FROM "posts"'
  surface: public
  cache: { sharedMaxAge: 60, staleWhileRevalidate: 30 }
`);
    expect(result.diagnostics.length).toBeGreaterThan(0);
  });

  it("accepts surface: internal and rejects shared caching", () => {
    const yaml = `apiVersion: cms.mantle.aotter.net/v2
kind: View
metadata: { name: internalView }
spec:
  sql: 'SELECT id FROM "posts"'
  surface: internal
`;
    expect(parseManifests(yaml).diagnostics).toEqual([]);
    expect(parseManifests(`${yaml}  cache: { sharedMaxAge: 60 }\n`).diagnostics)
      .toEqual([expect.objectContaining({
        code: "VIEW_CACHE_INVALID",
        source: expect.objectContaining({ path: "/spec/cache" }),
      })]);
  });

  it("rejects View Admin uiSchema on the public surface", () => {
    const result = parseManifests(`apiVersion: cms.mantle.aotter.net/v2
kind: View
metadata: { name: publicView }
spec:
  sql: 'SELECT id FROM "posts"'
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
  sql: 'SELECT id FROM "posts"'
`;
    const result = parseManifests(yaml);
    expect(result.diagnostics[0]?.message).toMatch(/surface is required/);
  });

  it("rejects an unknown surface string", () => {
    const yaml = `apiVersion: cms.mantle.aotter.net/v2
kind: View
metadata: { name: badView }
spec:
  sql: 'SELECT id FROM "posts"'
  surface: unknown
`;
    const result = parseManifests(yaml);
    expect(result.diagnostics.map((d) => d.message)).toContainEqual(
      expect.stringMatching(/View\.spec\.surface.*must be one of/),
    );
  });

  it("requires sql; compilePlan checks the statement itself", () => {
    const result = parseManifests(`apiVersion: cms.mantle.aotter.net/v2
kind: View
metadata: { name: bad }
spec: { surface: admin }
`);
    expect(result.diagnostics[0]?.message).toMatch(/sql is required/);
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

describe("parseManifests() — View.input", () => {
  const parseView = (spec: string) => parseManifests(`apiVersion: cms.mantle.aotter.net/v2
kind: View
metadata: { name: v }
spec:
  surface: public
  sql: SELECT id FROM posts WHERE locale = input.locale
  ${spec}
`);

  it.each([
    ["input: { type: string }", "VIEW_INPUT_INVALID_SHAPE"],
    ["input: { type: object }", "VIEW_INPUT_INVALID_SHAPE"],
    ["input: { type: object, properties: { cursor: { type: string } } }", "VIEW_INPUT_RESERVED_NAME"],
    ["input: { type: object, properties: { limit: { type: integer } } }", "VIEW_INPUT_RESERVED_NAME"],
    // 0.1.x keys: SQL replaced them
    ["params: { type: object, properties: {} }", "INVALID_MANIFEST_ENVELOPE"],
    ["filter: { eq: { field: a, value: 1 } }", "INVALID_MANIFEST_ENVELOPE"],
    ["orderBy: [{ field: id }]", "INVALID_MANIFEST_ENVELOPE"],
    ["from: posts", "INVALID_MANIFEST_ENVELOPE"],
  ])("rejects %s", (spec, code) => {
    expect(parseView(spec).diagnostics[0]?.code).toBe(code);
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
    ["unsupported composition", `{ allOf: [{ type: string }, { type: number }] }`, "JSON_SCHEMA_UNSUPPORTED"],
    // a $ref that reaches itself without reading a level of the value: every validation would overflow the stack
    ["a $ref to itself", `{ type: object, $defs: { a: { $ref: '#/$defs/a' } }, properties: { x: { $ref: '#/$defs/a' } } }`, "JSON_SCHEMA_REF_INVALID"],
    ["a $ref cycle through oneOf", `{ type: object, $defs: { a: { oneOf: [{ $ref: '#/$defs/b' }, { type: string }] }, b: { $ref: '#/$defs/a' } }, properties: { x: { $ref: '#/$defs/a' } } }`, "JSON_SCHEMA_REF_INVALID"],
    ["a $ref cycle nothing reads", `{ type: object, $defs: { a: { $ref: '#/$defs/a' } } }`, "JSON_SCHEMA_REF_INVALID"],
    ["a pattern with nested quantifiers", `{ type: object, properties: { s: { type: string, pattern: '^(a+)+$' } } }`, "INVALID_PATTERN"],
    ["a pattern repeating an alternation", `{ type: object, properties: { s: { type: string, pattern: '^(a|aa)*$' } } }`, "INVALID_PATTERN"],
    ["a pattern with a backreference", `{ type: object, properties: { s: { type: string, pattern: '^(a)\\1$' } } }`, "INVALID_PATTERN"],
    // adjacent variable quantifiers backtrack polynomially: maxLength^k past the work bound, or no maxLength at all
    ["twelve adjacent a*", `{ type: object, properties: { s: { type: string, maxLength: 31, pattern: '^a*a*a*a*a*a*a*a*a*a*a*a*$' } } }`, "INVALID_PATTERN"],
    ["eight adjacent \\w*", `{ type: object, properties: { s: { type: string, maxLength: 100, pattern: '\\w*\\w*\\w*\\w*\\w*\\w*\\w*\\w*$' } } }`, "INVALID_PATTERN"],
    ["four quantified groups in a row", `{ type: object, properties: { s: { type: string, maxLength: 100, pattern: '(a*)(a*)(a*)(a*)' } } }`, "INVALID_PATTERN"],
    ["a variable pattern without maxLength", `{ type: object, properties: { s: { type: string, pattern: '^[a-z0-9-]+$' } } }`, "INVALID_PATTERN"],
    ["a variable pattern in items without maxLength", `{ type: object, properties: { s: { type: array, items: { type: string, pattern: '^[^@]+@[^@]+$' } } } }`, "INVALID_PATTERN"],
    ["a variable pattern in $defs past the bound", `{ type: object, $defs: { e: { type: string, maxLength: 3163, pattern: '^[^@]+@[^@]+$' } }, properties: { s: { $ref: '#/$defs/e' } } }`, "INVALID_PATTERN"],
    ["an enum of more than 1000 values", `{ type: object, properties: { s: { enum: [${Array.from({ length: 1001 }, (_, i) => i).join(", ")}] } } }`, "JSON_SCHEMA_LIMIT_EXCEEDED"],
  ])("rejects %s with a stable diagnostic", (_label, input, code) => {
    const result = parseManifests(procedure(input));
    expect(result.diagnostics[0]?.code).toBe(code);
  });
});

describe("input rules (dependentRequired, anyOf, if/then/else)", () => {
  const rule = { dependentRequired: "{ a: [b] }", anyOf: "[{ required: [a] }]", if: "{ properties: { a: { const: x } }, required: [a] }", then: "{ required: [b] }" };
  const object = (rules: string) => `{ type: object, properties: { a: { type: string }, b: { type: string } }, ${rules} }`;
  const procedure = (input: string, output = "{ type: object }") => `apiVersion: cms.mantle.aotter.net/v2
kind: Procedure
metadata: { name: rules }
spec:
  input: ${input}
  output: ${output}
  handler: { ref: rules }
`;
  it("parse in Procedure input; generation checks their shapes", () => {
    expect(parseManifests(procedure(object(Object.entries(rule).map(([k, v]) => `${k}: ${v}`).join(", ")))).diagnostics).toEqual([]);
  });
  it.each(Object.entries(rule))("refuses %s in a Procedure output and a Schema", (keyword, value) => {
    const schema = `apiVersion: cms.mantle.aotter.net/v2
kind: Schema
metadata: { name: posts }
spec:
  title: Posts
  schema: ${object(`${keyword}: ${value}`)}
`;
    for (const text of [procedure("{ type: object }", object(`${keyword}: ${value}`)), schema]) {
      expect(parseManifests(text).diagnostics[0]).toMatchObject({ code: "JSON_SCHEMA_UNSUPPORTED", message: expect.stringContaining(`'${keyword}', which is supported only in View and Procedure input`) });
    }
  });
});

describe("the pattern work bound", () => {
  const procedure = (input: string) => `apiVersion: cms.mantle.aotter.net/v2
kind: Procedure
metadata: { name: bounded }
spec:
  input: ${input}
  output: { type: object }
  handler: { ref: bounded }
`;
  const input = (s: string) => parseManifests(procedure(`{ type: object, properties: { s: ${s} } }`)).diagnostics;
  it("accepts a pattern with no variable quantifier without maxLength, and an email up to maxLength 3162", () => {
    expect(input(`{ type: string, pattern: '^[A-Z]{3}$' }`)).toEqual([]);
    expect(input(`{ type: string, maxLength: 254, pattern: '^[^@]+@[^@]+$' }`)).toEqual([]);
    expect(input(`{ type: string, maxLength: 3162, pattern: '^[^@]+@[^@]+$' }`)).toEqual([]);
    expect(input(`{ type: string, maxLength: 3, pattern: '^a*a*a*a*a*a*a*a*a*a*a*a*$' }`)).toEqual([]);
  });
  it("names the bound and the fix", () => {
    const [missing] = input(`{ type: string, pattern: '^[^@]+@[^@]+$' }`);
    expect([missing?.code, missing?.path]).toEqual(["INVALID_PATTERN", "manifest:doc/0#/spec/input/properties/s/pattern"]);
    expect(missing?.message).toMatch(/maxLength of at most 3162/);
    const [over] = input(`{ type: string, maxLength: 4, pattern: '^a*a*a*a*a*a*a*a*a*a*a*a*$' }`);
    expect(over?.message).toMatch(/maxLength\^12.*maxLength of at most 3\b.*fewer variable quantifiers/s);
    const [paths] = input(`{ type: string, pattern: '^${"(a|b)".repeat(24)}$' }`);
    expect(paths?.message).toMatch(/16777216 alternative paths.*fewer alternatives/s);
    // an unanchored pattern is retried at every offset: one more factor of maxLength
    expect(input(`{ type: string, maxLength: 3162, pattern: '[a-z]*[a-z]*!' }`)[0]?.message).toMatch(/maxLength of at most 215\b/);
    expect(input(`{ type: string, maxLength: 100000, pattern: '[a-z]*!' }`)[0]?.message).toMatch(/maxLength of at most 3162\b/);
  });
  it("the worst accepted shape at its maxLength validates in well under 100 ms", () => {
    for (const [pattern, maxLength] of [["^a*a*a*a*a*a*a*a*a*a*a*a*$", 3], ["^.*.*.*.*.*.*.*$", 10], ["^[^@]+@[^@]+$", 3162], ["^[a-z0-9-]+$", 100_000], ["[a-z]*[a-z]*!", 215], ["[a-z]*!", 3162], ["^[^]a*a*]?$", 215], [`^${"(a|a)".repeat(23)}a*$`, 1]] as const) {
      expect(input(`{ type: string, maxLength: ${maxLength}, pattern: '${pattern}' }`)).toEqual([]);
      const zs = jsonSchemaToZod({ type: "string", maxLength, pattern });
      const worst = "a".repeat(maxLength - 1) + "!";
      const started = performance.now();
      zs.safeParse(worst);
      zs.safeParse("a".repeat(maxLength + 1) + "!");
      expect(performance.now() - started).toBeLessThan(100);
    }
  });
  it("a string past maxLength is refused before its pattern runs", () => {
    const zs = jsonSchemaToZod({ type: "object", properties: { s: { type: "string", maxLength: 3, pattern: "^a*a*a*a*a*a*a*a*a*a*a*a*$" } } });
    const started = performance.now();
    const result = zs.safeParse({ s: "a".repeat(30) + "b" });
    expect(performance.now() - started).toBeLessThan(100);
    expect(result.error?.issues.map((i) => i.code)).toEqual(["too_big"]);
  });
});
