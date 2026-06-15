import { describe, expect, it } from "vitest";
import { parseManifests } from "../src/domain/service/ManifestParser.js";
import { IntrospectManifestsUseCase } from "../src/usecase/IntrospectManifestsUseCase.js";
import { EmitOpenapiUseCase } from "../src/usecase/EmitOpenapiUseCase.js";
import { EmitTypesUseCase } from "../src/usecase/EmitTypesUseCase.js";

const FIXTURE = `apiVersion: cms.mantle.aotter.net/v1
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
---
apiVersion: cms.mantle.aotter.net/v1
kind: View
metadata: { name: posts-by-locale }
spec:
  from: posts
  params:
    type: object
    properties:
      locale: { type: string }
    required: [locale]
  filter:
    eq: { field: locale, value: { $param: locale } }
---
apiVersion: cms.mantle.aotter.net/v1
kind: Procedure
metadata: { name: submitContact }
spec:
  input:
    type: object
    required: [name]
    properties:
      name: { type: string }
  output: { type: object }
  handler: { kind: ref, ref: submitContact }
  requires:
    auth:
      all: [ctx.user]
---
apiVersion: cms.mantle.aotter.net/v1
kind: Trigger
metadata: { name: submitContactHttp }
spec:
  source: { kind: http, method: POST, path: /api/contact }
  target: { procedure: submitContact }
`;

function fixture() {
  const r = parseManifests(FIXTURE);
  expect(r.diagnostics).toEqual([]);
  return r.manifests;
}

describe("IntrospectManifestsUseCase", () => {
  it("partitions and surfaces derived shape", () => {
    const out = IntrospectManifestsUseCase.run({ manifests: fixture(), parseErrors: [] });
    expect(out.schemas).toHaveLength(1);
    expect(out.schemas[0]!).toMatchObject({
      name: "posts",
      localized: false,
      lifecycle: "simple",
    });
    expect(out.schemas[0]!.properties).toEqual(["slug", "title", "body"]);
    expect(out.views).toHaveLength(1);
    expect(out.views[0]!).toMatchObject({
      name: "posts-by-locale",
      from: "posts",
      restPath: "/api/views/posts-by-locale",
    });
    expect(out.views[0]!.params?.required).toEqual(["locale"]);
    expect(out.procedures).toHaveLength(1);
    expect(out.procedures[0]!.auth?.all).toEqual(["ctx.user"]);
    expect(out.triggers).toHaveLength(1);
    expect(out.adminActions).toHaveLength(1);
    expect(out.adminActions[0]).toMatchObject({
      name: "submitContact",
      operationKind: "generic",
      audience: "staff",
      manualRun: "recommended",
    });
    expect(out.adminActions[0]!.triggers[0]).toMatchObject({
      name: "submitContactHttp",
      sourceKind: "http",
      method: "POST",
      path: "/api/contact",
    });
  });

  it("projects admin action metadata only from explicit manifest declarations", () => {
    const parsed = parseManifests(`apiVersion: cms.mantle.aotter.net/v1
kind: Procedure
metadata: { name: totallyNeutralName }
spec:
  input: { type: object, description: Import contacts }
  output: { type: object, description: Import result }
  handler: { kind: ref, ref: contacts.import }
  admin:
    operationKind: system
    audience: agent
    manualRun: advanced
---
apiVersion: cms.mantle.aotter.net/v1
kind: Trigger
metadata: { name: neutralTrigger }
spec:
  source: { kind: mcp, surface: staff }
  target: { procedure: totallyNeutralName }
`);
    expect(parsed.diagnostics).toEqual([]);
    const out = IntrospectManifestsUseCase.run({ manifests: parsed.manifests, parseErrors: [] });
    expect(out.adminActions).toHaveLength(1);
    expect(out.adminActions[0]).toMatchObject({
      name: "totallyNeutralName",
      description: "Import contacts",
      outputDescription: "Import result",
      operationKind: "system",
      audience: "agent",
      manualRun: "advanced",
    });
    expect(out.adminActions[0]!.triggers[0]).toMatchObject({
      name: "neutralTrigger",
      sourceKind: "mcp",
      surface: "staff",
    });
  });
});

describe("EmitOpenapiUseCase", () => {
  it("emits one operation per HTTP Trigger and one per View", () => {
    const { document } = EmitOpenapiUseCase.run({
      manifests: fixture(),
      title: "Test",
      version: "0.1.0",
    });
    const paths = document["paths"] as Record<string, Record<string, { operationId: string }>>;
    expect(paths["/api/contact"]?.post?.operationId).toBe("post_submitContact");
    expect(paths["/api/views/posts-by-locale"]?.get?.operationId).toBe("view_posts_by_locale");
  });

  it("attaches `security: [{bearer:[]}]` when Procedure requires auth", () => {
    const { document } = EmitOpenapiUseCase.run({
      manifests: fixture(),
      title: "Test",
      version: "0.1.0",
    });
    const paths = document["paths"] as Record<string, Record<string, Record<string, unknown>>>;
    expect(paths["/api/contact"]!.post!["security"]).toEqual([{ bearer: [] }]);
  });

  it("View operation includes reserved page/show + declared params as query parameters", () => {
    const { document } = EmitOpenapiUseCase.run({
      manifests: fixture(),
      title: "Test",
      version: "0.1.0",
    });
    const paths = document["paths"] as Record<string, Record<string, Record<string, unknown>>>;
    const params = paths["/api/views/posts-by-locale"]!.get!["parameters"] as Array<{ name: string; required?: boolean }>;
    const names = params.map((p) => p.name);
    expect(names).toEqual(["page", "show", "locale"]);
    expect(params.find((p) => p.name === "locale")?.required).toBe(true);
  });

  it("auth-gated View emits security[bearer] + 401/403 responses (#210 PR16 / codex CX4)", () => {
    const gated = parseManifests(`apiVersion: cms.mantle.aotter.net/v1
kind: Schema
metadata: { name: posts }
spec:
  title: Posts
  schema: { type: object, properties: { slug: { type: string } } }
---
apiVersion: cms.mantle.aotter.net/v1
kind: View
metadata: { name: privatePosts }
spec:
  from: posts
  requires:
    auth:
      all: [ctx.user]
`);
    expect(gated.diagnostics).toEqual([]);
    const { document } = EmitOpenapiUseCase.run({
      manifests: gated.manifests,
      title: "Test",
      version: "0.1.0",
    });
    const paths = document["paths"] as Record<string, Record<string, Record<string, unknown>>>;
    const op = paths["/api/views/privatePosts"]!.get!;
    // Views use cookie auth (Better Auth session), not bearer —
    // bearer is for Procedure MCP/HTTP-Trigger surface.
    expect(op["security"]).toEqual([{ cookieAuth: [] }]);
    const responses = op["responses"] as Record<string, unknown>;
    expect(responses["401"]).toBeDefined();
    expect(responses["403"]).toBeDefined();
    // Verify the cookieAuth scheme is registered in components with
    // the secure production cookie name by default.
    const schemes = (document["components"] as { securitySchemes: Record<string, unknown> }).securitySchemes;
    expect(schemes["cookieAuth"]).toEqual({
      type: "apiKey",
      in: "cookie",
      name: "__Secure-better-auth.session_token",
    });
  });

  it("cookieAuth name can be overridden via sessionCookieName (local/non-secure deploys)", () => {
    const gated = parseManifests(`apiVersion: cms.mantle.aotter.net/v1
kind: Schema
metadata: { name: posts }
spec:
  title: Posts
  schema: { type: object, properties: { slug: { type: string } } }
---
apiVersion: cms.mantle.aotter.net/v1
kind: View
metadata: { name: localPrivate }
spec:
  from: posts
  requires: { auth: { all: [ctx.user] } }
`);
    const { document } = EmitOpenapiUseCase.run({
      manifests: gated.manifests,
      title: "Test",
      version: "0.1.0",
      sessionCookieName: "better-auth.session_token",
    });
    const schemes = (document["components"] as { securitySchemes: Record<string, unknown> }).securitySchemes;
    expect((schemes["cookieAuth"] as Record<string, unknown>)["name"]).toBe(
      "better-auth.session_token",
    );
  });

  it("public View emits no security + no 401/403 (no auth declared)", () => {
    const { document } = EmitOpenapiUseCase.run({
      manifests: fixture(),
      title: "Test",
      version: "0.1.0",
    });
    const paths = document["paths"] as Record<string, Record<string, Record<string, unknown>>>;
    const op = paths["/api/views/posts-by-locale"]!.get!;
    expect(op["security"]).toBeUndefined();
    const responses = op["responses"] as Record<string, unknown>;
    expect(responses["401"]).toBeUndefined();
    expect(responses["403"]).toBeUndefined();
  });
});

describe("EmitTypesUseCase", () => {
  it("emits Entry / ProcInput / ProcOutput / ViewRow interfaces", () => {
    const { source } = EmitTypesUseCase.run({ manifests: fixture(), namespace: "Test" });
    expect(source).toContain("export namespace Test {");
    expect(source).toContain("export interface Entry_posts");
    expect(source).toContain("export interface ProcInput_submitContact");
    expect(source).toContain("export interface ProcOutput_submitContact");
    expect(source).toContain("export interface ViewRow_posts_by_locale");
    // Required field is non-optional, optional field has `?`
    expect(source).toMatch(/slug: string;\n\s+title\?: string;/);
    // Reserved columns surface on every ViewRow
    expect(source).toContain("status: \"draft\" | \"published\" | \"archived\"");
  });
});
