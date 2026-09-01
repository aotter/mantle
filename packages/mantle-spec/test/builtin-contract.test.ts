import { describe, expect, it } from "vitest";
import { parseManifests, validateManifests } from "./parse.js";
import type {
  Manifest,
  ProcedureManifest,
  SchemaManifest,
} from "../src/domain/model/ManifestGrammar.js";

const postsSchema: SchemaManifest = {
  apiVersion: "cms.mantle.aotter.net/v1",
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
  apiVersion: "cms.mantle.aotter.net/v1",
  kind: "Schema",
  metadata: { name: "logs" },
  spec: {
    title: "Logs",
    schema: {
      type: "object",
      properties: {
        message: { type: "string" },
      },
    },
    lifecycle: "operational",
  },
};

function procedure(opts: {
  name: string;
  op: "create" | "update" | "upsert" | "delete" | "archive";
  schema?: string;
  match?: string[];
  input: Record<string, unknown>;
}): ProcedureManifest {
  return {
    apiVersion: "cms.mantle.aotter.net/v1",
    kind: "Procedure",
    metadata: { name: opts.name },
    spec: {
      input: opts.input as ProcedureManifest["spec"]["input"],
      output: { type: "object" },
      handler: {
        kind: "builtin",
        op: opts.op,
        schema: opts.schema ?? "posts",
        ...(opts.match ? { match: opts.match } : {}),
      },
    },
  };
}

describe("validateManifests — builtin handler contracts", () => {
  it("accepts valid create procedure", () => {
    const p = procedure({
      name: "createPost",
      op: "create",
      input: { type: "object", properties: { title: { type: "string" } } },
    });
    const res = validateManifests({ manifests: [postsSchema, p] });
    expect(res.diagnostics).toEqual([]);
    expect(res.errorCount).toBe(0);
  });

  it("accepts valid update procedure", () => {
    const p = procedure({
      name: "updatePost",
      op: "update",
      input: {
        type: "object",
        properties: {
          id: { type: "string" },
          expectedVersion: { type: "number" },
          title: { type: "string" },
        },
        required: ["id", "expectedVersion"],
      },
    });
    const res = validateManifests({ manifests: [postsSchema, p] });
    expect(res.diagnostics).toEqual([]);
    expect(res.errorCount).toBe(0);
  });

  it("accepts valid delete and archive procedures", () => {
    const del = procedure({
      name: "deletePost",
      op: "delete",
      input: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"],
      },
    });
    const arc = procedure({
      name: "archivePost",
      op: "archive",
      input: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"],
      },
    });
    const res = validateManifests({ manifests: [postsSchema, del, arc] });
    expect(res.diagnostics).toEqual([]);
    expect(res.errorCount).toBe(0);
  });

  it("accepts valid matched upsert procedures (single and composite unique index)", () => {
    const matchSlug = procedure({
      name: "upsertBySlug",
      op: "upsert",
      match: ["slug"],
      input: {
        type: "object",
        properties: {
          slug: { type: "string" },
          title: { type: "string" },
        },
        required: ["slug"],
      },
    });
    const matchComposite = procedure({
      name: "upsertByComposite",
      op: "upsert",
      match: ["slug", "variant"],
      input: {
        type: "object",
        properties: {
          slug: { type: "string" },
          variant: { type: "string" },
          title: { type: "string" },
        },
        required: ["slug", "variant"],
      },
    });
    const res = validateManifests({ manifests: [postsSchema, matchSlug, matchComposite] });
    expect(res.diagnostics).toEqual([]);
    expect(res.errorCount).toBe(0);
  });

  it("accepts legacy upsert with no id/expectedVersion or with both", () => {
    const legacyEmpty = procedure({
      name: "legacyUpsertEmpty",
      op: "upsert",
      input: {
        type: "object",
        properties: { title: { type: "string" } },
      },
    });
    const legacyBoth = procedure({
      name: "legacyUpsertBoth",
      op: "upsert",
      input: {
        type: "object",
        properties: {
          id: { type: "string" },
          expectedVersion: { type: "number" },
          title: { type: "string" },
        },
      },
    });
    const res = validateManifests({ manifests: [postsSchema, legacyEmpty, legacyBoth] });
    expect(res.diagnostics).toEqual([]);
    expect(res.errorCount).toBe(0);
  });

  it("rejects non-object input schema for builtin handlers", () => {
    const p = procedure({
      name: "createArray",
      op: "create",
      input: { type: "array" },
    });
    const res = validateManifests({ manifests: [postsSchema, p] });
    expect(res.errorCount).toBeGreaterThan(0);
    expect(res.diagnostics.some((d) => d.code === "BUILTIN_HANDLER_CONTRACT_INVALID")).toBe(true);
  });

  it("rejects update procedure missing id, expectedVersion, or required keys", () => {
    const noId = procedure({
      name: "updateNoId",
      op: "update",
      input: {
        type: "object",
        properties: { expectedVersion: { type: "number" } },
        required: ["expectedVersion"],
      },
    });
    const notRequired = procedure({
      name: "updateNotRequired",
      op: "update",
      input: {
        type: "object",
        properties: { id: { type: "string" }, expectedVersion: { type: "number" } },
        required: ["id"], // missing expectedVersion in required
      },
    });
    const resNoId = validateManifests({ manifests: [postsSchema, noId] });
    expect(resNoId.diagnostics.some((d) => d.code === "BUILTIN_HANDLER_CONTRACT_INVALID")).toBe(true);

    const resNotReq = validateManifests({ manifests: [postsSchema, notRequired] });
    expect(resNotReq.diagnostics.some((d) => d.code === "BUILTIN_HANDLER_CONTRACT_INVALID")).toBe(true);
  });

  it("rejects nullable union types for id and expectedVersion (exact strict types required)", () => {
    const nullableIdUnion = procedure({
      name: "updateNullableIdUnion",
      op: "update",
      input: {
        type: "object",
        properties: {
          id: { type: ["string", "null"] },
          expectedVersion: { type: "number" },
        },
        required: ["id", "expectedVersion"],
      },
    });
    const nullableIdProp = procedure({
      name: "updateNullableIdProp",
      op: "update",
      input: {
        type: "object",
        properties: {
          id: { type: "string", nullable: true },
          expectedVersion: { type: "number" },
        },
        required: ["id", "expectedVersion"],
      },
    });
    const nullableVersionUnion = procedure({
      name: "updateNullableVersionUnion",
      op: "update",
      input: {
        type: "object",
        properties: {
          id: { type: "string" },
          expectedVersion: { type: ["number", "null"] },
        },
        required: ["id", "expectedVersion"],
      },
    });
    const nullableVersionProp = procedure({
      name: "updateNullableVersionProp",
      op: "update",
      input: {
        type: "object",
        properties: {
          id: { type: "string" },
          expectedVersion: { type: "number", nullable: true },
        },
        required: ["id", "expectedVersion"],
      },
    });

    for (const p of [nullableIdUnion, nullableIdProp, nullableVersionUnion, nullableVersionProp]) {
      const res = validateManifests({ manifests: [postsSchema, p] });
      expect(res.errorCount).toBeGreaterThan(0);
      expect(res.diagnostics.some((d) => d.code === "BUILTIN_HANDLER_CONTRACT_INVALID")).toBe(true);
    }
  });

  it("rejects archive procedure targeting operational lifecycle Schema", () => {
    const arcOp = procedure({
      name: "archiveLog",
      op: "archive",
      schema: "logs",
      input: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"],
      },
    });
    const res = validateManifests({ manifests: [operationalSchema, arcOp] });
    expect(res.errorCount).toBeGreaterThan(0);
    const diag = res.diagnostics.find((d) => d.code === "BUILTIN_HANDLER_CONTRACT_INVALID");
    expect(diag).toBeDefined();
    expect(diag?.path).toMatch(/\/spec\/handler\/op$/);
    expect(diag?.value).toBe("archive");
  });

  it("rejects matched upsert when match does not match declared Schema uniqueIndexes", () => {
    const unindexed = procedure({
      name: "upsertByTitle",
      op: "upsert",
      match: ["title"], // title is not a unique index
      input: {
        type: "object",
        properties: { title: { type: "string" } },
        required: ["title"],
      },
    });
    const wrongOrder = procedure({
      name: "upsertWrongOrder",
      op: "upsert",
      match: ["variant", "slug"], // schema has ["slug", "variant"]
      input: {
        type: "object",
        properties: { slug: { type: "string" }, variant: { type: "string" } },
        required: ["variant", "slug"],
      },
    });
    const res1 = validateManifests({ manifests: [postsSchema, unindexed] });
    expect(res1.diagnostics.some((d) => d.code === "BUILTIN_HANDLER_CONTRACT_INVALID")).toBe(true);

    const res2 = validateManifests({ manifests: [postsSchema, wrongOrder] });
    expect(res2.diagnostics.some((d) => d.code === "BUILTIN_HANDLER_CONTRACT_INVALID")).toBe(true);
  });

  it("rejects matched upsert when matched field is missing from Procedure input or required", () => {
    const missingProp = procedure({
      name: "upsertMissingProp",
      op: "upsert",
      match: ["slug"],
      input: {
        type: "object",
        properties: { title: { type: "string" } }, // missing slug property
        required: ["slug"],
      },
    });
    const missingRequired = procedure({
      name: "upsertMissingReq",
      op: "upsert",
      match: ["slug"],
      input: {
        type: "object",
        properties: { slug: { type: "string" } },
        required: [], // missing slug in required
      },
    });
    const res1 = validateManifests({ manifests: [postsSchema, missingProp] });
    expect(res1.diagnostics.some((d) => d.code === "BUILTIN_HANDLER_CONTRACT_INVALID")).toBe(true);

    const res2 = validateManifests({ manifests: [postsSchema, missingRequired] });
    expect(res2.diagnostics.some((d) => d.code === "BUILTIN_HANDLER_CONTRACT_INVALID")).toBe(true);
  });

  it("rejects matched upsert when input declares id or expectedVersion", () => {
    const withId = procedure({
      name: "upsertWithId",
      op: "upsert",
      match: ["slug"],
      input: {
        type: "object",
        properties: { slug: { type: "string" }, id: { type: "string" } },
        required: ["slug"],
      },
    });
    const withVersion = procedure({
      name: "upsertWithVersion",
      op: "upsert",
      match: ["slug"],
      input: {
        type: "object",
        properties: { slug: { type: "string" }, expectedVersion: { type: "number" } },
        required: ["slug"],
      },
    });
    const res1 = validateManifests({ manifests: [postsSchema, withId] });
    expect(res1.diagnostics.some((d) => d.code === "BUILTIN_HANDLER_CONTRACT_INVALID")).toBe(true);

    const res2 = validateManifests({ manifests: [postsSchema, withVersion] });
    expect(res2.diagnostics.some((d) => d.code === "BUILTIN_HANDLER_CONTRACT_INVALID")).toBe(true);
  });

  it("rejects legacy upsert with only one of id or expectedVersion", () => {
    const onlyId = procedure({
      name: "upsertOnlyId",
      op: "upsert",
      input: {
        type: "object",
        properties: { id: { type: "string" } },
      },
    });
    const onlyVersion = procedure({
      name: "upsertOnlyVersion",
      op: "upsert",
      input: {
        type: "object",
        properties: { expectedVersion: { type: "number" } },
      },
    });
    const res1 = validateManifests({ manifests: [postsSchema, onlyId] });
    expect(res1.diagnostics.some((d) => d.code === "BUILTIN_HANDLER_CONTRACT_INVALID")).toBe(true);

    const res2 = validateManifests({ manifests: [postsSchema, onlyVersion] });
    expect(res2.diagnostics.some((d) => d.code === "BUILTIN_HANDLER_CONTRACT_INVALID")).toBe(true);
  });
});

describe("parseManifests — parser validation for handler.match", () => {
  it("rejects match on non-upsert op", () => {
    const yaml = `
apiVersion: cms.mantle.aotter.net/v1
kind: Procedure
metadata:
  name: createWithMatch
spec:
  input:
    type: object
  output:
    type: object
  handler:
    kind: builtin
    op: create
    schema: posts
    match: [slug]
`;
    const res = parseManifests(yaml);
    expect(res.diagnostics.some((d) => /Procedure.spec.handler.match is only valid when op is 'upsert'/.test(d.message))).toBe(true);
  });

  it("rejects empty match array or non-string elements", () => {
    const emptyYaml = `
apiVersion: cms.mantle.aotter.net/v1
kind: Procedure
metadata:
  name: emptyMatch
spec:
  input:
    type: object
  output:
    type: object
  handler:
    kind: builtin
    op: upsert
    schema: posts
    match: []
`;
    const resEmpty = parseManifests(emptyYaml);
    expect(resEmpty.diagnostics.some((d) => /Procedure.spec.handler.match must be a non-empty array/.test(d.message))).toBe(true);

    const dupYaml = `
apiVersion: cms.mantle.aotter.net/v1
kind: Procedure
metadata:
  name: dupMatch
spec:
  input:
    type: object
  output:
    type: object
  handler:
    kind: builtin
    op: upsert
    schema: posts
    match: [slug, slug]
`;
    const resDup = parseManifests(dupYaml);
    expect(resDup.diagnostics.some((d) => /contains duplicate field/.test(d.message))).toBe(true);
  });
});
