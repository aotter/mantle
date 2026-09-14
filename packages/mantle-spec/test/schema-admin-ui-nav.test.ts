import { describe, expect, it } from "vitest";
import { checkSchemaAdminUi } from "../src/domain/service/SchemaAdminUiChecker.js";
import type { SchemaManifest } from "../src/domain/model/ManifestGrammar.js";
import { parseManifests, validateManifests } from "./parse.js";

const parent = `apiVersion: cms.mantle.aotter.net/v1
kind: Schema
metadata: { name: organizations }
spec:
  title: Organizations
  schema:
    type: object
    required: [name]
    properties:
      name: { type: string }
`;

const child = (body: string) => `apiVersion: cms.mantle.aotter.net/v1
kind: Schema
metadata: { name: projects }
spec:
  title: Projects
  schema:
    type: object
    required: [name, organizationId]
    properties:
      name: { type: string }
      organizationId: { type: string, x-mantle-ref: organizations }
  ${body}
`;

function parsedSchema(source: string, name = "projects"): SchemaManifest {
  const result = parseManifests(source);
  expect(result.diagnostics, result.diagnostics.map((d) => d.message).join("\n")).toEqual([]);
  const schema = result.manifests.find((manifest) =>
    manifest.kind === "Schema" && manifest.metadata.name === name
  ) as SchemaManifest | undefined;
  expect(schema).toBeDefined();
  return schema!;
}

describe("Schema uiSchema closed roots", () => {
  it("rejects an unknown uiSchema root", () => {
    const result = parseManifests(child("uiSchema: { extra: true }"));
    expect(result.diagnostics[0]).toMatchObject({
      code: "SCHEMA_UI_INVALID",
      message: expect.stringContaining("uiSchema.extra"),
    });
  });

  it("rejects an unknown list key", () => {
    const result = parseManifests(`apiVersion: cms.mantle.aotter.net/v1
kind: Schema
metadata: { name: orders }
spec:
  title: Orders
  lifecycle: operational
  schema:
    type: object
    properties:
      kind: { type: string, enum: [a, b] }
  indexes: [[kind]]
  uiSchema:
    list:
      filterField: kind
      standaloneNav: true
`);
    expect(result.diagnostics[0]).toMatchObject({
      code: "SCHEMA_UI_INVALID",
      message: expect.stringContaining("list.standaloneNav"),
    });
  });

  it("rejects an unknown nav key", () => {
    const result = parseManifests(child(`uiSchema:
    nav:
      standalone: true
      unfold: true
`));
    expect(result.diagnostics[0]).toMatchObject({
      code: "SCHEMA_UI_INVALID",
      message: expect.stringContaining("nav.unfold"),
    });
  });

  it("rejects Procedure uiSchema.nav", () => {
    const result = parseManifests(`apiVersion: cms.mantle.aotter.net/v1
kind: Procedure
metadata: { name: place-order }
spec:
  input: { type: object }
  uiSchema: { nav: { standalone: true } }
  output: { type: object }
  handler: { kind: ref, ref: placeOrder }
`);
    expect(result.diagnostics[0]).toMatchObject({
      code: "SCHEMA_UI_INVALID",
      message: expect.stringContaining("uiSchema.nav"),
    });
  });
});

describe("Schema uiSchema.nav standalone", () => {
  it("omits nav by default (fold only)", () => {
    const schema = parsedSchema(`${parent}
---
${child("")}`);
    expect(checkSchemaAdminUi(schema).nav).toBeNull();
  });

  it("accepts standalone: false as fold only", () => {
    const schema = parsedSchema(child("uiSchema:\n    nav: { standalone: false }"));
    expect(checkSchemaAdminUi(schema).nav).toBeNull();
  });

  it("infers parentField when exactly one eligible required ref exists", () => {
    const schema = parsedSchema(child("uiSchema:\n    nav: { standalone: true }"));
    expect(checkSchemaAdminUi(schema).nav).toEqual({
      standalone: true,
      parentField: "organizationId",
      parentCollection: "organizations",
    });
  });

  it("accepts an explicit parentField that matches the only eligible ref", () => {
    const schema = parsedSchema(child("uiSchema:\n    nav: { standalone: true, parentField: organizationId }"));
    expect(checkSchemaAdminUi(schema).nav).toEqual({
      standalone: true,
      parentField: "organizationId",
      parentCollection: "organizations",
    });
  });

  it("rejects parentField without standalone: true", () => {
    const result = parseManifests(child("uiSchema:\n    nav: { parentField: organizationId }"));
    expect(result.diagnostics[0]).toMatchObject({
      code: "SCHEMA_UI_INVALID",
      message: expect.stringContaining("parentField requires nav.standalone: true"),
    });
  });

  it("rejects parentField when standalone is false", () => {
    const result = parseManifests(child("uiSchema:\n    nav: { standalone: false, parentField: organizationId }"));
    expect(result.diagnostics[0]?.code).toBe("SCHEMA_UI_INVALID");
  });

  it("rejects standalone on a top-level Schema", () => {
    const result = parseManifests(`${parent}
  uiSchema:
    nav: { standalone: true }
`);
    expect(result.diagnostics[0]).toMatchObject({
      code: "SCHEMA_UI_INVALID",
      message: expect.stringContaining("no required x-mantle-ref parent"),
    });
  });

  it("rejects standalone on a Schema whose only refs are optional", () => {
    const result = parseManifests(`apiVersion: cms.mantle.aotter.net/v1
kind: Schema
metadata: { name: notes }
spec:
  title: Notes
  schema:
    type: object
    required: [body]
    properties:
      body: { type: string }
      organizationId: { type: string, x-mantle-ref: organizations }
  uiSchema:
    nav: { standalone: true }
`);
    expect(result.diagnostics[0]?.code).toBe("SCHEMA_UI_INVALID");
  });

  it("rejects standalone on a translates child", () => {
    const result = parseManifests(`apiVersion: cms.mantle.aotter.net/v1
kind: Schema
metadata: { name: organization-translations }
spec:
  title: Organization translations
  localized: true
  translates: { parent: organizations, on: name }
  schema:
    type: object
    required: [name, title]
    properties:
      name: { type: string }
      locale: { type: string }
      title: { type: string }
  uiSchema:
    nav: { standalone: true }
`);
    expect(result.diagnostics[0]).toMatchObject({
      code: "SCHEMA_UI_INVALID",
      message: expect.stringContaining("translates child"),
    });
  });

  it("requires parentField when more than one eligible required ref exists", () => {
    const source = `apiVersion: cms.mantle.aotter.net/v1
kind: Schema
metadata: { name: memberships }
spec:
  title: Memberships
  schema:
    type: object
    required: [organizationId, projectId]
    properties:
      organizationId: { type: string, x-mantle-ref: organizations }
      projectId: { type: string, x-mantle-ref: projects }
  uiSchema:
    nav: { standalone: true }
`;
    const result = parseManifests(source);
    expect(result.diagnostics[0]).toMatchObject({
      code: "SCHEMA_UI_INVALID",
      message: expect.stringContaining("nav.parentField is required"),
    });
  });

  it("does not silently pick the first required ref when multiple exist", () => {
    const source = `apiVersion: cms.mantle.aotter.net/v1
kind: Schema
metadata: { name: memberships }
spec:
  title: Memberships
  schema:
    type: object
    required: [organizationId, projectId]
    properties:
      organizationId: { type: string, x-mantle-ref: organizations }
      projectId: { type: string, x-mantle-ref: projects }
  uiSchema:
    nav: { standalone: true }
`;
    expect(parseManifests(source).diagnostics[0]?.code).toBe("SCHEMA_UI_INVALID");
    const accepted = parseManifests(source.replace(
      "nav: { standalone: true }",
      "nav: { standalone: true, parentField: projectId }",
    ));
    expect(accepted.diagnostics).toEqual([]);
    const schema = accepted.manifests[0] as SchemaManifest;
    expect(checkSchemaAdminUi(schema).nav).toEqual({
      standalone: true,
      parentField: "projectId",
      parentCollection: "projects",
    });
  });

  it("rejects parentField that is not an eligible required ref", () => {
    const result = parseManifests(child("uiSchema:\n    nav: { standalone: true, parentField: name }"));
    expect(result.diagnostics[0]).toMatchObject({
      code: "SCHEMA_UI_INVALID",
      message: expect.stringContaining("must be 'organizationId'"),
    });
  });

  it("rejects a non-boolean standalone", () => {
    const result = parseManifests(child("uiSchema:\n    nav: { standalone: 1 }"));
    expect(result.diagnostics[0]?.code).toBe("SCHEMA_UI_INVALID");
  });
});

describe("Schema uiSchema.nav graph targets", () => {
  it("accepts standalone when the parent Schema exists", () => {
    const parsed = parseManifests(`${parent}
---
${child("uiSchema:\n    nav: { standalone: true }")}`);
    expect(parsed.diagnostics).toEqual([]);
    const result = validateManifests({ manifests: parsed.manifests });
    expect(result.diagnostics.filter((d) => d.code === "SCHEMA_UI_INVALID")).toEqual([]);
  });

  it("rejects standalone whose parent collection is missing", () => {
    const parsed = parseManifests(child("uiSchema:\n    nav: { standalone: true }"));
    expect(parsed.diagnostics).toEqual([]);
    const result = validateManifests({ manifests: parsed.manifests });
    expect(result.diagnostics[0]).toMatchObject({
      code: "SCHEMA_UI_INVALID",
      message: expect.stringContaining("organizations"),
    });
  });

  it("rejects standalone whose parent is a translates child", () => {
    const parsed = parseManifests(`apiVersion: cms.mantle.aotter.net/v1
kind: Schema
metadata: { name: organization-translations }
spec:
  title: Organization translations
  localized: true
  translates: { parent: organizations, on: name }
  schema:
    type: object
    required: [name, title]
    properties:
      name: { type: string }
      locale: { type: string }
      title: { type: string }
---
apiVersion: cms.mantle.aotter.net/v1
kind: Schema
metadata: { name: projects }
spec:
  title: Projects
  schema:
    type: object
    required: [translationName]
    properties:
      translationName: { type: string, x-mantle-ref: organization-translations }
  uiSchema:
    nav: { standalone: true }
`);
    expect(parsed.diagnostics).toEqual([]);
    const result = validateManifests({ manifests: parsed.manifests });
    expect(result.diagnostics.some((d) => d.code === "SCHEMA_UI_INVALID")).toBe(true);
  });
});
