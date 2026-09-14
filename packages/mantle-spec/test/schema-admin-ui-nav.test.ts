import { describe, expect, it } from "vitest";
import { checkSchemaAdminUi } from "../src/domain/service/SchemaAdminUiChecker.js";
import type { SchemaManifest } from "../src/domain/model/ManifestGrammar.js";
import { parseManifests, validateManifests } from "./parse.js";

function atom(kind: string, name: string, spec: string): string {
  return `apiVersion: cms.mantle.aotter.net/v1
kind: ${kind}
metadata: { name: ${name} }
spec:
${spec}`;
}

const org = atom("Schema", "organizations", `  title: Organizations
  schema: { type: object, required: [name], properties: { name: { type: string } } }`);

function projects(ui: string): string {
  return atom("Schema", "projects", `  title: Projects
  schema:
    type: object
    required: [name, organizationId]
    properties:
      name: { type: string }
      organizationId: { type: string, x-mantle-ref: organizations }
  ${ui}`);
}

function memberships(nav: string): string {
  return atom("Schema", "memberships", `  title: Memberships
  schema:
    type: object
    required: [organizationId, projectId]
    properties:
      organizationId: { type: string, x-mantle-ref: organizations }
      projectId: { type: string, x-mantle-ref: projects }
  uiSchema: { nav: ${nav} }`);
}

function translations(ui = ""): string {
  return atom("Schema", "organization-translations", `  title: Organization translations
  localized: true
  translates: { parent: organizations, on: name }
  schema:
    type: object
    required: [name, title]
    properties: { name: { type: string }, locale: { type: string }, title: { type: string } }
  ${ui}`);
}

const inferred = {
  standalone: true as const,
  parentField: "organizationId",
  parentCollection: "organizations",
};

function parsedSchema(source: string, name = "projects"): SchemaManifest {
  const result = parseManifests(source);
  expect(result.diagnostics, result.diagnostics.map((d) => d.message).join("\n")).toEqual([]);
  const schema = result.manifests.find((manifest) =>
    manifest.kind === "Schema" && manifest.metadata.name === name
  ) as SchemaManifest | undefined;
  expect(schema).toBeDefined();
  return schema!;
}

describe("Schema uiSchema.nav", () => {
  it.each([
    ["unknown uiSchema root", projects("uiSchema: { extra: true }"), "uiSchema.extra"],
    ["unknown list key", atom("Schema", "orders", `  title: Orders
  lifecycle: operational
  schema: { type: object, properties: { kind: { type: string, enum: [a, b] } } }
  indexes: [[kind]]
  uiSchema: { list: { filterField: kind, standaloneNav: true } }`), "list.standaloneNav"],
    ["unknown nav key", projects("uiSchema:\n    nav: { standalone: true, unfold: true }"), "nav.unfold"],
    ["Procedure uiSchema.nav", atom("Procedure", "place-order", `  input: { type: object }
  uiSchema: { nav: { standalone: true } }
  output: { type: object }
  handler: { kind: ref, ref: placeOrder }`), "uiSchema.nav"],
    ["parentField without standalone", projects("uiSchema:\n    nav: { parentField: organizationId }"),
      "parentField requires nav.standalone: true"],
    ["parentField when standalone is false",
      projects("uiSchema:\n    nav: { standalone: false, parentField: organizationId }"),
      "parentField requires nav.standalone: true"],
    ["standalone on a top-level Schema", `${org}\n  uiSchema:\n    nav: { standalone: true }`,
      "no required x-mantle-ref parent"],
    ["standalone with only optional refs", atom("Schema", "notes", `  title: Notes
  schema:
    type: object
    required: [body]
    properties:
      body: { type: string }
      organizationId: { type: string, x-mantle-ref: organizations }
  uiSchema: { nav: { standalone: true } }`), "no required x-mantle-ref parent"],
    ["standalone on a translates child", translations("uiSchema:\n    nav: { standalone: true }"),
      "translates child"],
    ["multi-ref without parentField", memberships("{ standalone: true }"), "nav.parentField is required"],
    ["parentField that is not an eligible ref",
      projects("uiSchema:\n    nav: { standalone: true, parentField: name }"), "must be 'organizationId'"],
    ["non-boolean standalone", projects("uiSchema:\n    nav: { standalone: 1 }"), "must be a boolean"],
  ])("rejects %s", (_label, source, needle) => {
    expect(parseManifests(source).diagnostics[0]).toMatchObject({
      code: "SCHEMA_UI_INVALID",
      message: expect.stringContaining(needle),
    });
  });

  it.each([
    ["omitted nav (fold only)", `${org}\n---\n${projects("")}`, null],
    ["standalone: false as fold only", projects("uiSchema:\n    nav: { standalone: false }"), null],
    ["inferred parentField for one required ref", projects("uiSchema:\n    nav: { standalone: true }"), inferred],
    ["explicit parentField matching the only ref",
      projects("uiSchema:\n    nav: { standalone: true, parentField: organizationId }"), inferred],
  ])("accepts %s", (_label, source, nav) => {
    expect(checkSchemaAdminUi(parsedSchema(source)).nav).toEqual(nav);
  });

  it("does not silently pick the first required ref when multiple exist", () => {
    const accepted = parseManifests(memberships("{ standalone: true, parentField: projectId }"));
    expect(accepted.diagnostics).toEqual([]);
    expect(checkSchemaAdminUi(accepted.manifests[0] as SchemaManifest).nav).toEqual({
      standalone: true,
      parentField: "projectId",
      parentCollection: "projects",
    });
  });

  it.each([
    ["the parent Schema exists", `${org}\n---\n${projects("uiSchema:\n    nav: { standalone: true }")}`, null],
    ["the parent collection is missing", projects("uiSchema:\n    nav: { standalone: true }"), "organizations"],
    ["the parent is a translates child", `${translations()}
---
${atom("Schema", "projects", `  title: Projects
  schema:
    type: object
    required: [translationName]
    properties:
      translationName: { type: string, x-mantle-ref: organization-translations }
  uiSchema: { nav: { standalone: true } }`)}`, "organization-translations"],
  ])("graph: %s", (_label, source, needle) => {
    const parsed = parseManifests(source);
    expect(parsed.diagnostics).toEqual([]);
    const ui = validateManifests({ manifests: parsed.manifests })
      .diagnostics.filter((diagnostic) => diagnostic.code === "SCHEMA_UI_INVALID");
    if (needle === null) expect(ui).toEqual([]);
    else expect(ui[0]).toMatchObject({ message: expect.stringContaining(needle) });
  });
});
