import { describe, expect, it } from "vitest";
import { parseManifests } from "./parse.js";
import { emitTypesFromManifests } from "../../src/spec/usecase/EmitTypes.js";
import type { LinkedManifestSet } from "../../src/spec/index.js";

const emit = (linked: LinkedManifestSet, namespace: string) =>
  emitTypesFromManifests({ schemas: linked.schemas.map((x) => x.manifest), procedures: linked.procedures.map((x) => x.manifest), views: linked.views.map((x) => x.manifest), namespace });

const FIXTURE = `apiVersion: cms.mantle.aotter.net/v2
kind: Schema
metadata: { name: posts }
spec:
  title: Posts
  schema:
    type: object
    required: [slug]
    properties:
      slug: { type: string }
      title: { type: string }
      body: { type: string }
      language: { type: string }
  indexes: [[title, slug], [language]]
  uniqueIndexes: [[slug]]
---
apiVersion: cms.mantle.aotter.net/v2
kind: View
metadata: { name: posts-by-locale }
spec:
  surface: public
  sql: SELECT id FROM posts WHERE language = input.locale
  cache: { sharedMaxAge: 300 }
  input:
    type: object
    properties:
      locale: { type: string }
    required: [locale]
---
apiVersion: cms.mantle.aotter.net/v2
kind: Procedure
metadata: { name: submitContact }
spec:
  input:
    type: object
    required: [name]
    properties:
      name: { type: string }
  output: { type: object }
  handler: { ref: submitContact }
  requires:
    auth:
      all: [ctx.user]
---
apiVersion: cms.mantle.aotter.net/v2
kind: Trigger
metadata: { name: submitContactHttp }
spec:
  source: { kind: http, method: POST, path: /api/contact }
  target: { procedure: submitContact }
`;

function fixture() {
  const r = parseManifests(FIXTURE);
  expect(r.diagnostics).toEqual([]);
  if (!r.linked) throw new Error("expected linked fixture");
  return r.linked;
}

describe("emitTypesFromManifests", () => {
  it("emits Entry / ProcInput / ProcOutput / ViewInput / ViewRow types", () => {
    const { source } = emit(fixture(), "Test");
    expect(source).toContain("export namespace Test {");
    expect(source).toContain("export interface Entry_posts");
    expect(source).toContain("export interface ProcInput_submitContact");
    expect(source).toContain("export interface ProcOutput_submitContact");
    expect(source).toContain("export type ViewInput_posts_u002d_by_u002d_locale");
    expect(source).toMatch(/ViewInput_posts_u002d_by_u002d_locale[^}]+locale: string;/s);
    // the row shape is the SELECT's output, known only to the SQL compiler
    expect(source).toContain("export type ViewRow_posts_u002d_by_u002d_locale = unknown;");
    // Required field is non-optional, optional field has `?`
    expect(source).toMatch(/slug: string;\n\s+title\?: string;/);
    expect(source).toContain("[key: string]: unknown;");
  });

  it("emits a `type` alias (not an interface) for a non-object top-level schema (#394)", () => {
    const yaml = `apiVersion: cms.mantle.aotter.net/v2
kind: Procedure
metadata: { name: ping }
spec:
  input: { type: string }
  output: { type: object }
  handler: { ref: ping }
`;
    const parsed = parseManifests(yaml);
    const { source } = emit(parsed.linked!, "Test");
    // `export interface ProcInput_ping string` would be a TS syntax error.
    expect(source).toContain("export type ProcInput_ping = string;");
    expect(source).not.toMatch(/export interface ProcInput_ping\s+string/);
  });

  it("keeps authored names inside generated documentation comments", () => {
    const yaml = `apiVersion: cms.mantle.aotter.net/v2
kind: Procedure
metadata: { name: "unsafe */\\nexport type Injected = true" }
spec:
  input: { type: object }
  output: { type: object }
  handler: { ref: safe }
`;
    const parsed = parseManifests(yaml);
    const { source } = emit(parsed.linked!, "Test");
    expect(source).not.toContain("unsafe */ export type Injected");
    expect(source).toContain("unsafe *\\/ export type Injected");
  });

  it("emits recursive refs, oneOf, const, and dictionary schemas without `unknown`", () => {
    const parsed = parseManifests(`apiVersion: cms.mantle.aotter.net/v2
kind: Procedure
metadata: { name: tree }
spec:
  input:
    $defs:
      node:
        type: object
        required: [value]
        properties:
          value: { oneOf: [{ const: leaf }, { const: branch }] }
          next: { $ref: '#/$defs/node' }
    $ref: '#/$defs/node'
  output: { type: object, additionalProperties: { type: integer } }
  handler: { ref: tree }
`);
    expect(parsed.diagnostics).toEqual([]);
    const { source } = emit(parsed.linked!, "Test");
    expect(source).toContain("export interface ProcInput_tree_node");
    expect(source).toContain('value: "leaf" | "branch";');
    expect(source).toContain("next?: ProcInput_tree_node;");
    expect(source).toContain("export type ProcInput_tree = ProcInput_tree_node;");
    expect(source).toContain("export type ProcOutput_tree = Record<string, number>;");
    expect(source).not.toContain(" = unknown;");
  });
});
