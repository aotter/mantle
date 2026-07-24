import { describe, expect, it } from "vitest";
import { ValidateManifestsUseCase } from "../src/usecase/ValidateManifestsUseCase.js";
import {
  parseManifests,
  parseManifestsOrThrow,
} from "../src/domain/service/ManifestParser.js";
import type {
  Manifest,
  ProcedureManifest,
  SchemaManifest,
  TriggerManifest,
  ViewManifest,
} from "../src/domain/model/ManifestGrammar.js";

/**
 * Tests for the Loop-1 validate check + the structural parse layer it
 * depends on. The check function is the library-level entry; consumer
 * test harnesses are expected to call it directly with parsed
 * manifests, so most cases here exercise that surface. INVALID_MANIFEST_ENVELOPE
 * is parser-emitted (it surfaces in the CLI when parseManifests
 * throws), so its test goes through parseManifests.
 */

const apiVersion = "cms.mantle.aotter.net/v1" as const;

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
    spec: { from, ...overrides },
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
      handler: { kind: "ref", ref: name },
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

describe("ValidateManifestsUseCase.run()", () => {
  it("returns no error diagnostics for a valid manifest set", () => {
    const manifests: Manifest[] = [
      schema("posts"),
      view("postList", "posts"),
      procedure("createPost"),
      trigger("createPostHttp", "createPost"),
    ];
    const result = ValidateManifestsUseCase.run({ manifests });
    expect(result.errorCount).toBe(0);
    expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  });

  it("validates comparison filter field references against the source Schema", () => {
    const result = ValidateManifestsUseCase.run({
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
          filter: { lte: { field: "safetyStock", value: 10 } },
        }),
      ],
    });

    const diagnostic = result.diagnostics.find(
      (d) => d.code === "VIEW_FILTER_FIELD_NOT_IN_SCHEMA",
    );
    expect(diagnostic?.path).toContain("/spec/filter/lte/field");
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
    const result = ValidateManifestsUseCase.run({ manifests });
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
    const result = ValidateManifestsUseCase.run({ manifests });
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
    const result = ValidateManifestsUseCase.run({ manifests });
    const codes = result.diagnostics.map((d) => d.code);
    expect(codes).toContain("TRIGGER_TARGET_PROCEDURE_UNKNOWN");
    expect(result.errorCount).toBeGreaterThan(0);
  });

  it("emits VIEW_FROM_UNKNOWN_SCHEMA when a View.from points at an undeclared Schema", () => {
    const manifests: Manifest[] = [
      // No Schema "posts".
      view("postList", "posts"),
    ];
    const result = ValidateManifestsUseCase.run({ manifests });
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
          properties: { slug: { type: "string" } },
        },
        localized: true,
        translates: { parent: "ghost", on: "slug" },
      },
    };
    const result = ValidateManifestsUseCase.run({ manifests: [child] });
    const codes = result.diagnostics.map((d) => d.code);
    expect(codes).toContain("TRANSLATES_PARENT_UNKNOWN");
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
    const result = ValidateManifestsUseCase.run({ manifests });
    const dups = result.diagnostics.filter((d) => d.code === "DUPLICATE_NAME");
    expect(dups).toHaveLength(4); // every copy including the original
    // First-occurrence diagnostic mentions ordinal 1, last mentions 4/4.
    expect(dups[0]?.message).toMatch(/occurrence 1 of 4/);
    expect(dups[3]?.message).toMatch(/occurrence 4 of 4/);
  });
});

describe("parseManifests() (envelope-shape errors return diagnostics)", () => {
  it("returns INVALID_MANIFEST_ENVELOPE diagnostic when metadata.name is missing", () => {
    const yaml = `apiVersion: cms.mantle.aotter.net/v1
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

describe("parseManifests() — v0.1.0 promoted grammar", () => {
  it("accepts Procedure.handler.kind: 'builtin' with op + schema", () => {
    const yaml = `apiVersion: cms.mantle.aotter.net/v1
kind: Procedure
metadata: { name: createPost }
spec:
  input: { type: object, properties: { data: { type: object } } }
  output: { type: object }
  handler:
    kind: builtin
    op: create
    schema: posts
`;
    const result = parseManifests(yaml);
    expect(result.diagnostics).toEqual([]);
    expect(result.manifests).toHaveLength(1);
    const proc = result.manifests[0] as ProcedureManifest;
    expect(proc.spec.handler.kind).toBe("builtin");
  });

  it("rejects builtin handler that also declares ref (mutually exclusive)", () => {
    const yaml = `apiVersion: cms.mantle.aotter.net/v1
kind: Procedure
metadata: { name: createPost }
spec:
  input: { type: object }
  output: { type: object }
  handler:
    kind: builtin
    op: create
    schema: posts
    ref: createPost
`;
    const result = parseManifests(yaml);
    expect(result.diagnostics.map((d) => d.code)).toContain("INVALID_MANIFEST_ENVELOPE");
  });

  it("accepts Trigger.source.kind: 'lifecycle' with on + schema", () => {
    const yaml = `apiVersion: cms.mantle.aotter.net/v1
kind: Trigger
metadata: { name: postsCaptcha }
spec:
  source:
    kind: lifecycle
    schema: posts
    on: [before_create]
    errorPolicy: abort
  target: { procedure: captchaCheck }
`;
    const result = parseManifests(yaml);
    expect(result.diagnostics).toEqual([]);
    expect(result.manifests).toHaveLength(1);
    const trig = result.manifests[0] as TriggerManifest;
    expect(trig.spec.source.kind).toBe("lifecycle");
  });

  it("rejects errorPolicy: 'abort' on after_* hooks", () => {
    const yaml = `apiVersion: cms.mantle.aotter.net/v1
kind: Trigger
metadata: { name: postsNotify }
spec:
  source:
    kind: lifecycle
    schema: posts
    on: [after_create]
    errorPolicy: abort
  target: { procedure: notifySlack }
`;
    const result = parseManifests(yaml);
    const messages = result.diagnostics.map((d) => d.message).join("\n");
    expect(messages).toMatch(/abort.*after_/);
  });

  it("accepts Trigger.source.kind: 'mcp' with surface: staff (#281 promotion)", () => {
    const yaml = `apiVersion: cms.mantle.aotter.net/v1
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
    const yaml = `apiVersion: cms.mantle.aotter.net/v1
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
    const yaml = `apiVersion: cms.mantle.aotter.net/v1
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
    const yaml = `apiVersion: cms.mantle.aotter.net/v1
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

  it("rejects Trigger.source.kind: 'mcp' mixed with lifecycle keys (schema/on/errorPolicy)", () => {
    const yaml = `apiVersion: cms.mantle.aotter.net/v1
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
    expect(result.diagnostics.map((d) => d.message).join("\n")).toMatch(
      /schema,on,errorPolicy.*are invalid when source.kind is 'mcp'/,
    );
  });

  it("rejects Trigger.source.kind: 'mcp' mixed with http keys (method/path)", () => {
    const yaml = `apiVersion: cms.mantle.aotter.net/v1
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
    expect(result.diagnostics.map((d) => d.message).join("\n")).toMatch(
      /method,path.*are invalid when source.kind is 'mcp'/,
    );
  });

  it("rejects errorPolicy: 'abort' when an after_* hook is mixed with before_* hooks", () => {
    // Regression: the prior guard used `.every(after_*)`, so a mixed
    // list of before + after with abort silently passed even though
    // after_* cannot abort.
    const yaml = `apiVersion: cms.mantle.aotter.net/v1
kind: Trigger
metadata: { name: postsMixed }
spec:
  source:
    kind: lifecycle
    schema: posts
    on: [before_create, after_create]
    errorPolicy: abort
  target: { procedure: doStuff }
`;
    const result = parseManifests(yaml);
    const messages = result.diagnostics.map((d) => d.message).join("\n");
    expect(messages).toMatch(/abort.*after_/);
  });
});

describe("parseManifests() — View.requires.auth", () => {
  it("accepts a View with requires.auth.all = [ctx.user]", () => {
    const yaml = `apiVersion: cms.mantle.aotter.net/v1
kind: View
metadata: { name: privatePosts }
spec:
  from: posts
  requires:
    auth:
      all: [ctx.user]
`;
    const result = parseManifests(yaml);
    expect(result.diagnostics).toEqual([]);
  });

  it("accepts ctx.auth and scalar ctx.auth.scope predicates", () => {
    const yaml = `apiVersion: cms.mantle.aotter.net/v1
kind: View
metadata: { name: scopedPosts }
spec:
  from: posts
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
    const yaml = `apiVersion: cms.mantle.aotter.net/v1
kind: View
metadata: { name: scopedPosts }
spec:
  from: posts
  requires:
    auth:
      all: [{ "ctx.auth.scope": "" }]
`;
    const result = parseManifests(yaml);
    expect(result.diagnostics[0]?.message).toContain("non-empty string");
  });

  it("rejects View.requires.auth.all with a role outside STAFF_ROLES", () => {
    const yaml = `apiVersion: cms.mantle.aotter.net/v1
kind: View
metadata: { name: secretView }
spec:
  from: posts
  requires:
    auth:
      all: [{ "ctx.staff": ["superadmin"] }]
`;
    const result = parseManifests(yaml);
    expect(result.diagnostics.map((d) => d.code)).toContain("AUTH_PREDICATE_NOT_IN_ENUM");
  });

  it("rejects View.requires.auth.any (DRAFT)", () => {
    const yaml = `apiVersion: cms.mantle.aotter.net/v1
kind: View
metadata: { name: vAny }
spec:
  from: posts
  requires:
    auth:
      any: [ctx.user]
`;
    const result = parseManifests(yaml);
    expect(result.diagnostics.map((d) => d.code)).toContain("DRAFT_KEY_USED");
  });

  it("rejects View.requires.auth.all with a non-STAFF_ROLES role (parser-level)", () => {
    const yaml = `apiVersion: cms.mantle.aotter.net/v1
kind: View
metadata: { name: vStaff }
spec:
  from: posts
  requires:
    auth:
      all: [{ "ctx.staff": ["superadmin"] }]
`;
    const result = parseManifests(yaml);
    expect(result.diagnostics.map((d) => d.code)).toContain("AUTH_PREDICATE_NOT_IN_ENUM");
  });
});

describe("requires.guard", () => {
  it("parses the single Procedure guard sub-spec on Procedure and View", () => {
    const yaml = `apiVersion: cms.mantle.aotter.net/v1
kind: Procedure
metadata: { name: guardedWrite }
spec:
  input: { type: object }
  output: { type: object }
  requires: { guard: { procedure: requirePaid } }
  handler: { kind: ref, ref: guardedWrite }
---
apiVersion: cms.mantle.aotter.net/v1
kind: View
metadata: { name: guardedRead }
spec:
  from: posts
  requires: { guard: { procedure: requirePaid } }
`;
    const result = parseManifests(yaml);
    expect(result.diagnostics).toEqual([]);
  });

  it("rejects guard keys beyond procedure", () => {
    const yaml = `apiVersion: cms.mantle.aotter.net/v1
kind: View
metadata: { name: guardedRead }
spec:
  from: posts
  requires: { guard: { procedure: requirePaid, cache: true } }
`;
    const result = parseManifests(yaml);
    expect(result.diagnostics[0]?.message).toContain("accepts only `procedure`");
  });

  it("validates missing, self, builtin, and chained guard targets", () => {
    const missing = procedure("missingTarget", {
      requires: { guard: { procedure: "notThere" } },
    });
    const self = procedure("selfGuard", {
      requires: { guard: { procedure: "selfGuard" } },
    });
    const builtin = procedure("builtinGuard", {
      handler: { kind: "builtin", op: "create", schema: "posts" },
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

    const result = ValidateManifestsUseCase.run({
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
    expect(codes).toContain("GUARD_PROCEDURE_BUILTIN");
    expect(codes).toContain("GUARD_CHAIN_NOT_ALLOWED");
  });
});

describe("parseManifests() — View.spec.surface (#433)", () => {
  it("accepts surface: public", () => {
    const yaml = `apiVersion: cms.mantle.aotter.net/v1
kind: View
metadata: { name: publicView }
spec:
  from: posts
  surface: public
`;
    const result = parseManifests(yaml);
    expect(result.diagnostics).toEqual([]);
    const view = result.manifests[0] as ViewManifest;
    expect(view.spec.surface).toBe("public");
  });

  it("accepts surface: staff", () => {
    const yaml = `apiVersion: cms.mantle.aotter.net/v1
kind: View
metadata: { name: staffView }
spec:
  from: posts
  surface: staff
`;
    const result = parseManifests(yaml);
    expect(result.diagnostics).toEqual([]);
    const view = result.manifests[0] as ViewManifest;
    expect(view.spec.surface).toBe("staff");
  });

  it("accepts an absent surface (defaults to public semantics)", () => {
    const yaml = `apiVersion: cms.mantle.aotter.net/v1
kind: View
metadata: { name: defaultView }
spec:
  from: posts
`;
    const result = parseManifests(yaml);
    expect(result.diagnostics).toEqual([]);
    const view = result.manifests[0] as ViewManifest;
    expect(view.spec.surface).toBeUndefined();
  });

  it("rejects an unknown surface string", () => {
    const yaml = `apiVersion: cms.mantle.aotter.net/v1
kind: View
metadata: { name: badView }
spec:
  from: posts
  surface: admin
`;
    const result = parseManifests(yaml);
    expect(result.diagnostics.map((d) => d.message)).toContainEqual(
      expect.stringMatching(/View\.spec\.surface must be one of/),
    );
  });
});

describe("parseManifests() — YAML alias-bomb regression (#210 H4)", () => {
  it("surfaces an INVALID_MANIFEST_ENVELOPE diagnostic on exponentially-expanding aliases", () => {
    // Deep nested aliases: each level multiplies the expansion 10x.
    // `maxAliasCount: 100` in ManifestParser triggers the yaml lib's
    // bail — the parser now catches that throw and converts it to a
    // structured diagnostic instead of propagating as an uncaught
    // ReferenceError.
    const yaml = `apiVersion: cms.mantle.aotter.net/v1
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

describe("parseManifests() — View.params + filter param-ref grammar (v0.1.0)", () => {
  const acceptYaml = (yaml: string) => {
    const r = parseManifests(yaml);
    expect(r.diagnostics).toEqual([]);
    return r;
  };

  it("accepts a View with no params (static query)", () => {
    acceptYaml(`apiVersion: cms.mantle.aotter.net/v1
kind: View
metadata: { name: postsPublished }
spec:
  from: posts
  filter:
    eq: { field: status, value: published }
`);
  });

  it("accepts a View with required params + filter param-ref sentinel", () => {
    const r = acceptYaml(`apiVersion: cms.mantle.aotter.net/v1
kind: View
metadata: { name: postsByLocale }
spec:
  from: posts
  params:
    type: object
    properties:
      locale: { type: string }
    required: [locale]
  filter:
    and:
      - eq: { field: status, value: published }
      - eq: { field: locale, value: { $param: locale } }
`);
    const v = r.manifests[0] as ViewManifest;
    expect(v.spec.params?.required).toEqual(["locale"]);
  });

  it("accepts comparison filters with literal and param-ref values", () => {
    acceptYaml(`apiVersion: cms.mantle.aotter.net/v1
kind: View
metadata: { name: stockMovementsInRange }
spec:
  from: stock-movements
  params:
    type: object
    properties:
      startAt: { type: string }
      endAt: { type: string }
    required: [startAt, endAt]
  filter:
    and:
      - gte: { field: occurredAt, value: { $param: startAt } }
      - lt: { field: occurredAt, value: { $param: endAt } }
      - gt: { field: quantity, value: 0 }
`);
  });

  it("rejects View.spec.params when type !== object", () => {
    const r = parseManifests(`apiVersion: cms.mantle.aotter.net/v1
kind: View
metadata: { name: bad }
spec:
  from: posts
  params:
    type: string
`);
    expect(r.diagnostics.map((d) => d.code)).toContain("VIEW_PARAMS_INVALID_SHAPE");
  });

  it("rejects View.spec.params with reserved name 'page'", () => {
    const r = parseManifests(`apiVersion: cms.mantle.aotter.net/v1
kind: View
metadata: { name: bad }
spec:
  from: posts
  params:
    type: object
    properties:
      page: { type: integer }
    required: [page]
`);
    expect(r.diagnostics.map((d) => d.code)).toContain("VIEW_PARAMS_RESERVED_NAME");
  });

  it("rejects View.spec.params with reserved name 'show'", () => {
    const r = parseManifests(`apiVersion: cms.mantle.aotter.net/v1
kind: View
metadata: { name: bad }
spec:
  from: posts
  params:
    type: object
    properties:
      show: { type: integer }
    required: [show]
`);
    expect(r.diagnostics.map((d) => d.code)).toContain("VIEW_PARAMS_RESERVED_NAME");
  });

  it("rejects filter param-ref pointing at undeclared params", () => {
    const r = parseManifests(`apiVersion: cms.mantle.aotter.net/v1
kind: View
metadata: { name: bad }
spec:
  from: posts
  filter:
    eq: { field: locale, value: { $param: locale } }
`);
    expect(r.diagnostics.map((d) => d.code)).toContain("VIEW_FILTER_PARAM_REF_UNKNOWN");
  });

  it("rejects filter param-ref to a param not in required (v0.1.0 required-only)", () => {
    const r = parseManifests(`apiVersion: cms.mantle.aotter.net/v1
kind: View
metadata: { name: bad }
spec:
  from: posts
  params:
    type: object
    properties:
      locale: { type: string }
  filter:
    eq: { field: locale, value: { $param: locale } }
`);
    expect(r.diagnostics.map((d) => d.code)).toContain(
      "VIEW_FILTER_PARAM_REF_NOT_REQUIRED",
    );
  });

  it("rejects filter param-ref naming a property the params schema does not declare", () => {
    const r = parseManifests(`apiVersion: cms.mantle.aotter.net/v1
kind: View
metadata: { name: bad }
spec:
  from: posts
  params:
    type: object
    properties:
      locale: { type: string }
    required: [locale]
  filter:
    eq: { field: tag, value: { $param: tag } }
`);
    expect(r.diagnostics.map((d) => d.code)).toContain("VIEW_FILTER_PARAM_REF_UNKNOWN");
  });

  it("rejects comparison filter param-ref to a param not in required", () => {
    const r = parseManifests(`apiVersion: cms.mantle.aotter.net/v1
kind: View
metadata: { name: bad }
spec:
  from: posts
  params:
    type: object
    properties:
      minStock: { type: integer }
  filter:
    lt: { field: currentStock, value: { $param: minStock } }
`);
    expect(r.diagnostics.map((d) => d.code)).toContain(
      "VIEW_FILTER_PARAM_REF_NOT_REQUIRED",
    );
  });
});

describe("parseManifestsOrThrow", () => {
  const okYaml = `apiVersion: cms.mantle.aotter.net/v1
kind: Schema
metadata: { name: posts }
spec:
  title: Posts
  schema: { type: object, properties: { slug: { type: string } } }
  uniqueIndexes: [[slug]]
  lifecycle: simple
`;

  it("returns the parsed manifests when no diagnostics fire", () => {
    const out = parseManifestsOrThrow(okYaml);
    expect(out).toHaveLength(1);
    expect(out[0]?.kind).toBe("Schema");
  });

  it("throws with diagnostics formatted as `[CODE] path: msg`", () => {
    const bad = `apiVersion: cms.mantle.aotter.net/v1
kind: Schema
metadata: { name: posts }
spec:
  schema: { type: object }
  uniqueIndexes: [[ "slug" ]]
  lifecycle: editorial
`;
    expect(() => parseManifestsOrThrow(bad)).toThrow(/Manifest parse failed:/);
    try {
      parseManifestsOrThrow(bad);
    } catch (e) {
      expect(String(e)).toMatch(/\[[A-Z_]+\] /);
    }
  });

  it("includes the context label in the error envelope when supplied", () => {
    expect(() =>
      parseManifestsOrThrow("not even yaml: : :", { context: "starters/publication" }),
    ).toThrow(/Manifest parse failed in starters\/publication/);
  });
});

describe("parseManifests() — ctx.staff role-enum enforcement", () => {
  it("rejects ctx.staff with a role that is not in STAFF_ROLES", () => {
    const yaml = `apiVersion: cms.mantle.aotter.net/v1
kind: Procedure
metadata: { name: secret }
spec:
  input: { type: object }
  output: { type: object }
  requires:
    auth:
      all: [{ "ctx.staff": ["superadmin"] }]
  handler: { kind: ref, ref: secretFn }
`;
    const result = parseManifests(yaml);
    expect(result.diagnostics.map((d) => d.code)).toContain("AUTH_PREDICATE_NOT_IN_ENUM");
  });

  it("accepts ctx.staff with all roles in STAFF_ROLES", () => {
    const yaml = `apiVersion: cms.mantle.aotter.net/v1
kind: Procedure
metadata: { name: editor }
spec:
  input: { type: object }
  output: { type: object }
  requires:
    auth:
      all: [{ "ctx.staff": ["owner", "editor"] }]
  handler: { kind: ref, ref: editorFn }
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
 *   1. Quoted string literal — `registerHandler('captchaCheck', fn)`
 *      or `handlers: { 'captchaCheck': fn }`.
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
    const result = ValidateManifestsUseCase.run({ manifests: [captchaProcedure], handlerSource: source });
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
    const result = ValidateManifestsUseCase.run({
      manifests: [captchaProcedure, procedure("slackNotify")],
      handlerSource: source,
    });
    expect(result.diagnostics.filter((d) => d.code === "HANDLER_NOT_REGISTERED")).toEqual([]);
  });

  it("emits HANDLER_NOT_REGISTERED when the ref is absent from source entirely", () => {
    const source = `export function buildHandlers() { return {}; }`;
    const result = ValidateManifestsUseCase.run({ manifests: [captchaProcedure], handlerSource: source });
    const diag = result.diagnostics.find((d) => d.code === "HANDLER_NOT_REGISTERED");
    expect(diag?.severity).toBe("warning");
    expect(diag?.value).toBe("captchaCheck");
  });

  it("does not false-positive on a substring match — `captchaCheckHelper` is not `captchaCheck`", () => {
    const source = `const captchaCheckHelper = () => true;`;
    const result = ValidateManifestsUseCase.run({ manifests: [captchaProcedure], handlerSource: source });
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
    const result = ValidateManifestsUseCase.run({ manifests: [captchaProcedure], handlerSource: source });
    // Comment is not a property key (no \`:\` follows the word) and not
    // a quoted string. Expect the warning to fire.
    const diag = result.diagnostics.find((d) => d.code === "HANDLER_NOT_REGISTERED");
    expect(diag).toBeDefined();
  });
});

describe("View orderBy direction (#392)", () => {
  it("rejects an orderBy direction outside asc/desc at parse time", () => {
    const yaml = `apiVersion: cms.mantle.aotter.net/v1
kind: View
metadata: { name: posts-sorted }
spec:
  from: posts
  orderBy:
    - { field: id, direction: "DESC LIMIT 0 --" }
`;
    const result = parseManifests(yaml);
    expect(result.manifests).toHaveLength(0);
    expect(result.diagnostics.map((d) => d.code)).toContain("VIEW_ORDERBY_INVALID");
  });

  it("accepts asc/desc and a bare field", () => {
    const yaml = `apiVersion: cms.mantle.aotter.net/v1
kind: View
metadata: { name: posts-sorted }
spec:
  from: posts
  orderBy:
    - { field: createdAt, direction: desc }
    - { field: id }
`;
    expect(parseManifests(yaml).diagnostics).toEqual([]);
  });
});

describe("required field absent from properties (#399)", () => {
  it("flags a required entry not declared in properties", () => {
    const result = ValidateManifestsUseCase.run({
      manifests: [
        schema("posts", {
          schema: {
            type: "object",
            properties: { title: { type: "string" } },
            required: ["title", "slug"],
          },
        }),
      ],
    });
    const diag = result.diagnostics.find((d) => d.code === "REQUIRED_FIELD_UNKNOWN");
    expect(diag).toBeDefined();
    expect(diag?.value).toBe("slug");
  });
});

describe("uncompilable regex pattern (#395)", () => {
  it("flags a malformed `pattern` at validate time instead of crashing at runtime", () => {
    const result = ValidateManifestsUseCase.run({
      manifests: [
        schema("posts", {
          schema: {
            type: "object",
            properties: { slug: { type: "string", pattern: "(unterminated" } },
          },
        }),
      ],
    });
    const diag = result.diagnostics.find((d) => d.code === "INVALID_PATTERN");
    expect(diag).toBeDefined();
  });
});
