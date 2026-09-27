import { describe, expect, it } from "vitest";
import { parseManifests, validateManifests } from "./parse.js";
import type {
  JsonSchema,
  LifecycleHook,
  Manifest,
  ProcedureManifest,
  SchemaManifest,
  StoreProgramOp,
} from "../../src/spec/domain/model/ManifestGrammar.js";

/** Inline Store program contracts (ADR-0032 decisions 1, 2 and 5). */

const apiVersion = "cms.mantle.aotter.net/v2" as const;

const postsSchema: SchemaManifest = {
  apiVersion,
  kind: "Schema",
  metadata: { name: "posts" },
  spec: {
    title: "Posts",
    schema: {
      type: "object",
      properties: {
        title: { type: "string" },
        slug: { type: "string" },
        variant: { type: "string" },
        body: { type: "string" },
      },
    },
    uniqueIndexes: [["slug"], ["slug", "variant"]],
    lifecycle: "publishing",
  },
};

const operationalSchema: SchemaManifest = {
  apiVersion,
  kind: "Schema",
  metadata: { name: "logs" },
  spec: {
    title: "Logs",
    schema: {
      type: "object",
      properties: {
        message: { type: "string" },
        performedAt: { type: "number" },
      },
    },
    lifecycle: "operational",
  },
};

const scopedSchema: SchemaManifest = {
  apiVersion,
  kind: "Schema",
  metadata: { name: "notes" },
  spec: {
    title: "Notes",
    schema: {
      type: "object",
      properties: {
        ownerId: { type: "string" },
        text: { type: "string" },
      },
      required: ["ownerId"],
    },
    indexes: [["ownerId"]],
    scope: { ownerId: "$ctx.user.id" },
    lifecycle: "operational",
  },
};

const idInput: JsonSchema = {
  type: "object",
  properties: { id: { type: "string" } },
  required: ["id"],
};

const updateInput: JsonSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    expectedVersion: { type: "number" },
    title: { type: "string" },
  },
  required: ["id", "expectedVersion"],
};

function procedure(opts: {
  name: string;
  store: readonly StoreProgramOp[];
  input: JsonSchema;
  output?: JsonSchema;
  spec?: Partial<ProcedureManifest["spec"]>;
}): ProcedureManifest {
  return {
    apiVersion,
    kind: "Procedure",
    metadata: { name: opts.name },
    spec: {
      input: opts.input,
      output: opts.output ?? { type: "object" },
      handler: { store: opts.store },
      ...opts.spec,
    },
  };
}

const create = (schema = "posts"): StoreProgramOp => ({ insert: schema, values: { title: "Untitled" } });
const update = (schema = "posts"): StoreProgramOp => ({
  update: schema,
  set: { title: "Edited" },
  where: { id: "$input.id" },
  lock: "$input.expectedVersion",
});
const remove = (schema = "posts"): StoreProgramOp => ({ delete: schema, where: { id: "$input.id" } });
const archive = (schema = "posts"): StoreProgramOp => ({
  update: schema,
  set: { status: "archived" },
  where: { id: "$input.id" },
});

function lifecycleTrigger(schema: string, on: readonly LifecycleHook[]): Manifest[] {
  return [
    {
      apiVersion,
      kind: "Procedure",
      metadata: { name: `${schema}-hook` },
      spec: { input: { type: "object" }, output: { type: "object" }, handler: { ref: `${schema}Hook` } },
    },
    {
      apiVersion,
      kind: "Trigger",
      metadata: { name: `${schema}-hook-trigger` },
      spec: { source: { kind: "lifecycle", schema, on }, target: { procedure: `${schema}-hook` } },
    },
  ];
}

function codes(manifests: Manifest[]): string[] {
  return validateManifests({ manifests }).diagnostics.filter((d) => d.severity === "error").map((d) => d.code);
}

function errorsOf(manifests: Manifest[]) {
  return validateManifests({ manifests }).diagnostics.filter((d) => d.severity === "error");
}

describe("validateManifests — inline Store program contracts", () => {
  it("accepts a create program", () => {
    const p = procedure({
      name: "createPost",
      store: [create()],
      input: { type: "object", properties: { title: { type: "string" } } },
    });
    const res = validateManifests({ manifests: [postsSchema, p] });
    expect(res.diagnostics).toEqual([]);
    expect(res.errorCount).toBe(0);
  });

  it("accepts an update program", () => {
    const p = procedure({ name: "updatePost", store: [update()], input: updateInput });
    const res = validateManifests({ manifests: [postsSchema, p] });
    expect(res.diagnostics).toEqual([]);
    expect(res.errorCount).toBe(0);
  });

  it("accepts delete and archive programs", () => {
    const del = procedure({ name: "deletePost", store: [remove()], input: idInput });
    const arc = procedure({ name: "archivePost", store: [archive()], input: idInput });
    const res = validateManifests({ manifests: [postsSchema, del, arc] });
    expect(res.diagnostics).toEqual([]);
    expect(res.errorCount).toBe(0);
  });

  it("accepts onConflict upserts over a single and a composite unique index", () => {
    const bySlug = procedure({
      name: "upsertBySlug",
      store: [{ insert: "posts", values: { slug: "$input.slug", title: "$input.title" }, onConflict: { columns: ["slug"], update: ["title"] } }],
      input: {
        type: "object",
        properties: { slug: { type: "string" }, title: { type: "string" } },
        required: ["slug"],
      },
    });
    const byComposite = procedure({
      name: "upsertByComposite",
      store: [{ insert: "posts", values: { slug: "$input.slug", variant: "$input.variant", title: "$input.title" }, onConflict: { columns: ["slug", "variant"], update: ["title"] } }],
      input: {
        type: "object",
        properties: { slug: { type: "string" }, variant: { type: "string" }, title: { type: "string" } },
        required: ["slug", "variant"],
      },
    });
    const res = validateManifests({ manifests: [postsSchema, bySlug, byComposite] });
    expect(res.diagnostics).toEqual([]);
    expect(res.errorCount).toBe(0);
  });

  it("rejects mcp.readOnlyHint: true, since a Store program always writes", () => {
    const p = procedure({
      name: "createReadOnly",
      store: [create()],
      input: { type: "object", properties: { title: { type: "string" } } },
      spec: { mcp: { readOnlyHint: true } },
    });
    expect(errorsOf([postsSchema, p])).toEqual([expect.objectContaining({
      code: "STORE_PROGRAM_INVALID",
      path: expect.stringMatching(/\/spec\/mcp\/readOnlyHint$/),
    })]);
  });

  it("rejects mcp.destructiveHint: false only when the program deletes", () => {
    const del = procedure({
      name: "deleteNotDestructive",
      store: [remove()],
      input: idInput,
      spec: { mcp: { destructiveHint: false } },
    });
    expect(errorsOf([postsSchema, del])).toEqual([expect.objectContaining({
      code: "STORE_PROGRAM_INVALID",
      path: expect.stringMatching(/\/spec\/mcp\/destructiveHint$/),
    })]);
    const upd = procedure({
      name: "updateNotDestructive",
      store: [update()],
      input: updateInput,
      spec: { mcp: { destructiveHint: false } },
    });
    expect(codes([postsSchema, upd])).toEqual([]);
  });

  it("rejects a program that writes an unknown Schema", () => {
    const p = procedure({ name: "createGhost", store: [create("ghosts")], input: { type: "object", properties: { title: { type: "string" } } } });
    expect(errorsOf([postsSchema, p])).toEqual([expect.objectContaining({
      code: "STORE_PROGRAM_SCHEMA_UNKNOWN",
      path: expect.stringMatching(/\/spec\/handler\/store\/0\/insert$/),
      value: "ghosts",
    })]);
  });

  it("accepts output schemas that admit { results } and rejects the rest", () => {
    const input: JsonSchema = { type: "object", properties: { title: { type: "string" } } };
    const withResults = procedure({
      name: "createWithResults",
      store: [create()],
      input,
      output: { type: "object", properties: { results: { type: "array" } }, required: ["results"] },
    });
    expect(codes([postsSchema, withResults])).toEqual([]);
    for (const output of [
      { type: "array" },
      { type: "object", required: ["id"] },
      { type: "object", properties: { results: { type: "object" } } },
    ] as JsonSchema[]) {
      const p = procedure({ name: "createBadOutput", store: [create()], input, output });
      expect(errorsOf([postsSchema, p])).toEqual([expect.objectContaining({
        code: "STORE_PROGRAM_INVALID",
        path: expect.stringMatching(/\/spec\/output$/),
      })]);
    }
  });

  it("rejects an update whose id or lock reference is undeclared or not required", () => {
    const noId = procedure({
      name: "updateNoId",
      store: [update()],
      input: { type: "object", properties: { expectedVersion: { type: "number" } }, required: ["expectedVersion"] },
    });
    const lockNotRequired = procedure({
      name: "updateLockNotRequired",
      store: [update()],
      input: { type: "object", properties: { id: { type: "string" }, expectedVersion: { type: "number" } }, required: ["id"] },
    });
    expect(codes([postsSchema, noId])).toContain("STORE_REFERENCE_UNKNOWN");
    expect(codes([postsSchema, lockNotRequired])).toContain("STORE_REFERENCE_NOT_REQUIRED");
  });

  it("requires id to be a string input and lock a number input", () => {
    const numberId = procedure({
      name: "updateNumberId",
      store: [update()],
      input: { ...updateInput, properties: { ...updateInput.properties, id: { type: "number" } } },
    });
    expect(errorsOf([postsSchema, numberId])).toEqual(expect.arrayContaining([expect.objectContaining({
      code: "STORE_PROGRAM_INVALID",
      path: expect.stringMatching(/\/spec\/handler\/store\/0\/where\/id$/),
    })]));
    const stringLock = procedure({
      name: "updateStringLock",
      store: [update()],
      input: { ...updateInput, properties: { ...updateInput.properties, expectedVersion: { type: "string" } } },
    });
    expect(errorsOf([postsSchema, stringLock])).toEqual(expect.arrayContaining([expect.objectContaining({
      code: "STORE_PROGRAM_INVALID",
      path: expect.stringMatching(/\/spec\/handler\/store\/0\/lock$/),
    })]));
  });

  it.each([
    [{ id: { type: ["string", "null"] } }],
    [{ id: { type: "string", nullable: true } }],
    [{ expectedVersion: { type: ["number", "null"] } }],
    [{ expectedVersion: { type: "number", nullable: true } }],
  ] as Array<[Record<string, JsonSchema>]>)("rejects nullable id and lock input %j (exact strict types required)", (override) => {
    const p = procedure({
      name: "updateNullable",
      store: [update()],
      input: { ...updateInput, properties: { ...updateInput.properties, ...override } },
    });
    const res = validateManifests({ manifests: [postsSchema, p] });
    expect(res.errorCount).toBeGreaterThan(0);
  });

  it("rejects archiving (setting status on) an operational Schema", () => {
    const p = procedure({ name: "archiveLog", store: [archive("logs")], input: idInput });
    const diag = errorsOf([operationalSchema, p]).find((d) => d.code === "STORE_PROGRAM_INVALID");
    expect(diag).toBeDefined();
    expect(diag?.path).toMatch(/\/spec\/handler\/store\/0\/set\/status$/);
    expect(diag?.value).toBe("archived");
  });

  it("rejects onConflict columns that are not exactly a declared unique index", () => {
    const unindexed = procedure({
      name: "upsertByTitle",
      store: [{ insert: "posts", values: { title: "$input.title", body: "$input.body" }, onConflict: { columns: ["title"], update: ["body"] } }],
      input: { type: "object", properties: { title: { type: "string" }, body: { type: "string" } }, required: ["title"] },
    });
    const wrongOrder = procedure({
      name: "upsertWrongOrder",
      store: [{ insert: "posts", values: { slug: "$input.slug", variant: "$input.variant", title: "$input.title" }, onConflict: { columns: ["variant", "slug"], update: ["title"] } }],
      input: { type: "object", properties: { slug: { type: "string" }, variant: { type: "string" }, title: { type: "string" } }, required: ["variant", "slug"] },
    });
    const duplicate = procedure({
      name: "upsertDuplicate",
      store: [{ insert: "posts", values: { slug: "$input.slug", title: "$input.title" }, onConflict: { columns: ["slug", "slug"], update: ["title"] } }],
      input: { type: "object", properties: { slug: { type: "string" }, title: { type: "string" } }, required: ["slug"] },
    });
    for (const p of [unindexed, wrongOrder, duplicate]) {
      expect(errorsOf([postsSchema, p])).toEqual([expect.objectContaining({
        code: "STORE_PROGRAM_INVALID",
        path: expect.stringMatching(/\/spec\/handler\/store\/0\/onConflict\/columns$/),
      })]);
    }
  });

  it("rejects onConflict when a conflict column is not a declared input property", () => {
    const p = procedure({
      name: "upsertMissingProp",
      store: [{ insert: "posts", values: { slug: "$input.slug", title: "$input.title" }, onConflict: { columns: ["slug"], update: ["title"] } }],
      input: { type: "object", properties: { title: { type: "string" } } },
    });
    expect(codes([postsSchema, p])).toContain("STORE_REFERENCE_UNKNOWN");
  });

  it("rejects onConflict when a conflict column is an optional input property", () => {
    const p = procedure({
      name: "upsertMissingReq",
      store: [{ insert: "posts", values: { slug: "$input.slug", title: "$input.title" }, onConflict: { columns: ["slug"], update: ["title"] } }],
      input: { type: "object", properties: { slug: { type: "string" }, title: { type: "string" } } },
    });
    expect(codes([postsSchema, p])).toContain("STORE_PROGRAM_INVALID");
  });

  it("rejects a non-object input schema", () => {
    const p = procedure({ name: "createArray", store: [create()], input: { type: "array" } });
    expect(validateManifests({ manifests: [postsSchema, p] }).errorCount).toBeGreaterThan(0);
  });

  it("rejects an insert that writes the native id column through values", () => {
    const p = procedure({
      name: "upsertWithId",
      store: [{ insert: "posts", values: { slug: "$input.slug", id: "$input.id" }, onConflict: { columns: ["slug"], update: ["slug"] } }],
      input: { type: "object", properties: { slug: { type: "string" }, id: { type: "string" } }, required: ["slug", "id"] },
    });
    expect(codes([postsSchema, p])).toContain("STORE_PROGRAM_INVALID");
  });

  it("requires a client insert id to be a required, strict scalar input", () => {
    const optional = procedure({
      name: "insertOptionalId",
      store: [{ insert: "posts", values: { title: "$input.title" }, id: "$input.id" }],
      input: { type: "object", properties: { id: { type: "string" }, title: { type: "string" } } },
    });
    const nullable = procedure({
      name: "insertNullableId",
      store: [{ insert: "posts", values: { title: "$input.title" }, id: "$input.id" }],
      input: { type: "object", properties: { id: { type: ["string", "null"] }, title: { type: "string" } }, required: ["id"] },
    });
    expect(codes([postsSchema, optional])).toContain("STORE_REFERENCE_NOT_REQUIRED");
    expect(codes([postsSchema, nullable])).toContain("STORE_REFERENCE_UNKNOWN");
  });
});

describe("validateManifests — row ops and set ops (ADR-0032 decision 2)", () => {
  const byMessage: JsonSchema = { type: "object", properties: { message: { type: "string" } }, required: ["message"] };

  it("rejects a set op on a publishing Schema", () => {
    const p = procedure({
      name: "archiveBySlug",
      store: [{ update: "posts", set: { title: "$input.title" }, where: { slug: "$input.slug" } }],
      input: { type: "object", properties: { slug: { type: "string" }, title: { type: "string" } }, required: ["slug"] },
    });
    expect(errorsOf([postsSchema, p])).toEqual([expect.objectContaining({
      code: "STORE_SET_OP_REJECTED",
      path: expect.stringMatching(/\/spec\/handler\/store\/0\/where$/),
    })]);
  });

  it("accepts a set op on an operational Schema without per-row hooks", () => {
    const p = procedure({ name: "purgeLogs", store: [{ delete: "logs", where: { message: "$input.message" } }], input: byMessage });
    expect(codes([operationalSchema, p])).toEqual([]);
  });

  it("rejects a set op on a Schema with per-row hooks for that operation only", () => {
    const p = procedure({ name: "purgeLogs", store: [{ delete: "logs", where: { message: "$input.message" } }], input: byMessage });
    for (const hook of ["before_delete", "after_delete"] as const) {
      expect(errorsOf([operationalSchema, p, ...lifecycleTrigger("logs", [hook])])).toEqual([expect.objectContaining({
        code: "STORE_SET_OP_REJECTED",
        path: expect.stringMatching(/\/spec\/handler\/store\/0\/where$/),
      })]);
    }
    expect(codes([operationalSchema, p, ...lifecycleTrigger("logs", ["before_update", "after_create"])])).toEqual([]);
  });

  it("rejects lock on a set op", () => {
    const p = procedure({
      name: "lockedPurge",
      store: [{ delete: "logs", where: { message: "$input.message" }, lock: "$input.expectedVersion" }],
      input: { type: "object", properties: { message: { type: "string" }, expectedVersion: { type: "number" } }, required: ["message", "expectedVersion"] },
    });
    expect(errorsOf([operationalSchema, p])).toEqual([expect.objectContaining({
      code: "STORE_PROGRAM_INVALID",
      path: expect.stringMatching(/\/spec\/handler\/store\/0\/lock$/),
    })]);
  });

  it("treats a where that pins id ANDed with more conditions as a row op", () => {
    const store: StoreProgramOp[] = [{
      delete: "logs",
      where: { id: "$input.id", performedAt: { gte: "$input.cutoff" } },
      lock: "$input.expectedVersion",
    }];
    const input: JsonSchema = {
      type: "object",
      properties: { id: { type: "string" }, cutoff: { type: "number" }, expectedVersion: { type: "number" } },
      required: ["id", "cutoff", "expectedVersion"],
    };
    // Hooks on the operation and lock would both be rejected on a set op.
    const p = procedure({ name: "deleteOldLog", store, input });
    expect(codes([operationalSchema, p, ...lifecycleTrigger("logs", ["before_delete"])])).toEqual([]);
  });
});

describe("validateManifests — scoped Schemas need a caller", () => {
  const input: JsonSchema = { type: "object", properties: { text: { type: "string" } } };

  it("rejects a program writing a scoped Schema without requires ctx.user", () => {
    const p = procedure({ name: "createNote", store: [{ insert: "notes", values: { text: "$input.text" } }], input });
    expect(errorsOf([scopedSchema, p])).toEqual([expect.objectContaining({
      code: "STORE_CALLER_REQUIRED",
      path: expect.stringMatching(/\/spec\/requires\/auth\/all$/),
    })]);
  });

  it("accepts it once the Procedure requires ctx.user", () => {
    const p = procedure({ name: "createNote", store: [{ insert: "notes", values: { text: "$input.text" } }], input, spec: { requires: { auth: { all: ["ctx.user"] } } } });
    expect(codes([scopedSchema, p])).toEqual([]);
  });

  it("also requires ctx.user when a program uses $ctx.user.id", () => {
    const p = procedure({
      name: "logCaller",
      store: [{ insert: "logs", values: { message: "$ctx.user.id" } }],
      input: { type: "object" },
    });
    expect(codes([operationalSchema, p])).toEqual(["STORE_CALLER_REQUIRED"]);
  });
});

describe("parseManifests — Store program shapes", () => {
  const doc = (handler: string) => `
apiVersion: cms.mantle.aotter.net/v2
kind: Procedure
metadata:
  name: shape
spec:
  input:
    type: object
    properties:
      slug: { type: string }
    required: [slug]
  output:
    type: object
  handler: ${handler}
`;

  it("rejects the v1 builtin handler with a migration suggestion", () => {
    const res = parseManifests(doc("{ kind: builtin, op: create, schema: posts }"));
    expect(res.diagnostics).toEqual([expect.objectContaining({
      code: "INVALID_MANIFEST_ENVELOPE",
      suggestion: expect.stringContaining("mantle-update"),
    })]);
  });

  it("rejects onConflict on a non-insert op", () => {
    const res = parseManifests(doc(`{ store: [{ update: posts, set: { slug: $input.slug }, where: { id: x }, onConflict: ignore }] }`));
    expect(res.diagnostics.length).toBeGreaterThan(0);
    expect(res.diagnostics[0]?.path).toContain("/spec/handler/store/0");
  });

  it("rejects empty onConflict columns or non-string elements", () => {
    for (const columns of ["[]", "[1]"]) {
      const res = parseManifests(doc(`{ store: [{ insert: posts, values: { slug: $input.slug }, onConflict: { columns: ${columns}, update: [slug] } }] }`));
      expect(res.diagnostics).toEqual([expect.objectContaining({
        code: "STORE_PROGRAM_INVALID",
        message: expect.stringMatching(/onConflict\.columns must be a non-empty array/),
      })]);
    }
  });

  it("rejects an empty program", () => {
    const res = parseManifests(doc("{ store: [] }"));
    expect(res.diagnostics).toEqual([expect.objectContaining({ code: "STORE_PROGRAM_INVALID" })]);
  });
});

describe("Schema reserved Procedure input names", () => {
  it("rejects Schema data properties named expectedVersion", () => {
    const colliding: SchemaManifest = {
      apiVersion,
      kind: "Schema",
      metadata: { name: "posts" },
      spec: {
        title: "Posts",
        schema: {
          type: "object",
          properties: {
            title: { type: "string" },
            expectedVersion: { type: "number" },
          },
        },
        lifecycle: "publishing",
      },
    };
    const res = validateManifests({ manifests: [colliding] });
    expect(res.errorCount).toBeGreaterThan(0);
    expect(res.diagnostics.some((d) =>
      d.code === "INVALID_MANIFEST_ENVELOPE" &&
      d.path.includes("/spec/schema/properties/expectedVersion") &&
      /reserved Procedure input name/.test(d.message),
    )).toBe(true);

    const yaml = parseManifests(`
apiVersion: cms.mantle.aotter.net/v2
kind: Schema
metadata: { name: logs }
spec:
  title: Logs
  lifecycle: operational
  schema:
    type: object
    properties:
      message: { type: string }
      expectedVersion: { type: number }
`);
    expect(yaml.diagnostics.some((d) =>
      d.code === "INVALID_MANIFEST_ENVELOPE" &&
      /reserved Procedure input name 'expectedVersion'/.test(d.message),
    )).toBe(true);
  });
});
