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
  indexes: [[title, slug]]
  uniqueIndexes: [[slug]]
---
apiVersion: cms.mantle.aotter.net/v1
kind: View
metadata: { name: posts-by-locale }
spec:
  surface: public
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
      lifecycle: "publishing",
      indexes: [["title", "slug"]],
      uniqueIndexes: [["slug"]],
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

  it("projects HTTP path fields out of the body without changing the Procedure schema (#531)", () => {
    const parsed = parseManifests(`apiVersion: cms.mantle.aotter.net/v1
kind: Procedure
metadata: { name: reserve-site }
spec:
  input:
    type: object
    required: [siteId, operationId]
    properties:
      siteId: { type: string, minLength: 1, description: Site selected by the URL. }
      operationId: { type: string, minLength: 1 }
      note: { type: string }
  output: { type: object }
  handler: { kind: ref, ref: reserveSite }
---
apiVersion: cms.mantle.aotter.net/v1
kind: Trigger
metadata: { name: reserve-site-http }
spec:
  source: { kind: http, method: POST, path: "/api/sites/{siteId}/reserve" }
  target: { procedure: reserve-site }
`);
    expect(parsed.diagnostics).toEqual([]);
    const procedure = parsed.manifests.find((manifest) => manifest.kind === "Procedure");
    expect(procedure?.kind).toBe("Procedure");
    if (!procedure || procedure.kind !== "Procedure") throw new Error("missing Procedure fixture");
    const originalInput = structuredClone(procedure.spec.input);

    const { document } = EmitOpenapiUseCase.run({
      manifests: parsed.manifests,
      title: "Test",
      version: "0.1.0",
    });
    const paths = document["paths"] as Record<string, Record<string, Record<string, unknown>>>;
    const operation = paths["/api/sites/{siteId}/reserve"]!.post!;
    expect(operation["parameters"]).toEqual([
      {
        name: "siteId",
        in: "path",
        required: true,
        schema: {
          type: "string",
          minLength: 1,
          description: "Site selected by the URL.",
        },
      },
    ]);
    const bodySchema = (
      ((operation["requestBody"] as Record<string, unknown>)["content"] as Record<
        string,
        Record<string, unknown>
      >)["application/json"]!["schema"]
    ) as {
      required: string[];
      properties: Record<string, unknown>;
    };
    expect(bodySchema.required).toEqual(["operationId"]);
    expect(Object.keys(bodySchema.properties)).toEqual(["operationId", "note"]);
    expect(bodySchema.properties["siteId"]).toBeUndefined();
    expect(procedure.spec.input).toEqual(originalInput);
  });

  it("attaches the default session-cookie scheme when Procedure requires auth", () => {
    const { document } = EmitOpenapiUseCase.run({
      manifests: fixture(),
      title: "Test",
      version: "0.1.0",
    });
    const paths = document["paths"] as Record<string, Record<string, Record<string, unknown>>>;
    expect(paths["/api/contact"]!.post!["security"]).toEqual([{ sessionCookie: [] }]);
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

  it("auth-gated View emits session-cookie security + 401/403 responses", () => {
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
  surface: public
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
    expect(op["security"]).toEqual([{ sessionCookie: [] }]);
    const responses = op["responses"] as Record<string, unknown>;
    expect(responses["401"]).toBeDefined();
    expect(responses["403"]).toBeDefined();
    // Verify the sessionCookie scheme is registered in components with
    // the secure production cookie name by default.
    const schemes = (document["components"] as { securitySchemes: Record<string, unknown> }).securitySchemes;
    expect(schemes["sessionCookie"]).toEqual({
      type: "apiKey",
      in: "cookie",
      name: "__Secure-better-auth.session_token",
    });
  });

  it("sessionCookie name can be overridden via sessionCookieName (local/non-secure deploys)", () => {
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
  surface: public
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
    expect((schemes["sessionCookie"] as Record<string, unknown>)["name"]).toBe(
      "better-auth.session_token",
    );
  });

  it("reflects configured API key, OAuth, PAT scopes, and dynamic guard accurately", () => {
    const parsed = parseManifests(`apiVersion: cms.mantle.aotter.net/v1
kind: Procedure
metadata: { name: requirePaid }
spec:
  input: { type: object }
  output: { type: object }
  handler: { kind: ref, ref: requirePaid }
---
apiVersion: cms.mantle.aotter.net/v1
kind: Procedure
metadata: { name: readOrders }
spec:
  input: { type: object }
  output: { type: object }
  requires:
    auth:
      all:
        - ctx.auth
        - { "ctx.auth.scope": "orders:read" }
        - { "ctx.auth.scope": "tenant:read" }
    guard: { procedure: requirePaid }
  handler: { kind: ref, ref: readOrders }
---
apiVersion: cms.mantle.aotter.net/v1
kind: Trigger
metadata: { name: readOrdersHttp }
spec:
  source: { kind: http, method: POST, path: /api/orders/read }
  target: { procedure: readOrders }
`);
    expect(parsed.diagnostics).toEqual([]);
    const { document } = EmitOpenapiUseCase.run({
      manifests: parsed.manifests,
      title: "Test",
      version: "0.1.0",
      security: {
        sessionCookie: false,
        oauthBearer: {
          openIdConnectUrl: "https://auth.example.test/.well-known/openid-configuration",
        },
        apiKey: { in: "header", name: "X-API-Key" },
        personalToken: { bearerFormat: "PAT" },
      },
    });
    const paths = document["paths"] as Record<string, Record<string, Record<string, unknown>>>;
    const op = paths["/api/orders/read"]!.post!;
    expect(op["security"]).toEqual([
      { oauthBearer: ["orders:read", "tenant:read"] },
      { apiKey: [] },
      { personalToken: [] },
    ]);
    expect(op["x-mantle-required-scopes"]).toEqual(["orders:read", "tenant:read"]);
    expect(op["x-mantle-guard-procedure"]).toBe("requirePaid");
    expect((op["responses"] as Record<string, unknown>)["402"]).toBeDefined();
    const schemes = (document["components"] as {
      securitySchemes: Record<string, unknown>;
    }).securitySchemes;
    expect(schemes).toMatchObject({
      oauthBearer: {
        type: "openIdConnect",
        openIdConnectUrl: "https://auth.example.test/.well-known/openid-configuration",
      },
      apiKey: { type: "apiKey", in: "header", name: "X-API-Key" },
      personalToken: { type: "http", scheme: "bearer", bearerFormat: "PAT" },
    });
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

  it("collapses a LocalizedText property `description` on Procedure input to a plain string (#453)", () => {
    const localized = parseManifests(`apiVersion: cms.mantle.aotter.net/v1
kind: Procedure
metadata: { name: submitContact }
spec:
  input:
    type: object
    required: [name]
    properties:
      name: { type: string, description: { en: "Contact name.", "zh-TW": "聯絡人姓名。" } }
  output: { type: object }
  handler: { kind: ref, ref: submitContact }
---
apiVersion: cms.mantle.aotter.net/v1
kind: Trigger
metadata: { name: submitContactHttp }
spec:
  source: { kind: http, method: POST, path: /api/contact }
  target: { procedure: submitContact }
`);
    expect(localized.diagnostics).toEqual([]);
    const { document } = EmitOpenapiUseCase.run({
      manifests: localized.manifests,
      title: "Test",
      version: "0.1.0",
    });
    const paths = document["paths"] as Record<string, Record<string, Record<string, unknown>>>;
    const requestSchema = (
      (paths["/api/contact"]!.post!["requestBody"] as Record<string, unknown>)["content"] as Record<
        string,
        Record<string, unknown>
      >
    )["application/json"]!["schema"] as { properties: { name: { description: unknown } } };
    expect(requestSchema.properties.name.description).toBe("Contact name.");
  });

  it("collapses a LocalizedText property `description` on View params to a plain string (#453)", () => {
    const localized = parseManifests(`apiVersion: cms.mantle.aotter.net/v1
kind: Schema
metadata: { name: posts }
spec:
  title: Posts
  schema: { type: object, properties: { slug: { type: string } } }
---
apiVersion: cms.mantle.aotter.net/v1
kind: View
metadata: { name: posts-by-locale }
spec:
  surface: public
  from: posts
  params:
    type: object
    properties:
      locale: { type: string, description: { en: "Locale filter.", "zh-TW": "語系篩選。" } }
    required: [locale]
  filter:
    eq: { field: locale, value: { $param: locale } }
`);
    expect(localized.diagnostics).toEqual([]);
    const { document } = EmitOpenapiUseCase.run({
      manifests: localized.manifests,
      title: "Test",
      version: "0.1.0",
    });
    const paths = document["paths"] as Record<string, Record<string, Record<string, unknown>>>;
    const params = paths["/api/views/posts-by-locale"]!.get!["parameters"] as Array<{
      name: string;
      schema: { description?: unknown };
    }>;
    expect(params.find((p) => p.name === "locale")?.schema.description).toBe("Locale filter.");
  });
});

describe("EmitTypesUseCase", () => {
  it("emits Entry / ProcInput / ProcOutput / ViewParams / ViewRow interfaces", () => {
    const { source } = EmitTypesUseCase.run({ manifests: fixture(), namespace: "Test" });
    expect(source).toContain("export namespace Test {");
    expect(source).toContain("export interface Entry_posts");
    expect(source).toContain("export interface ProcInput_submitContact");
    expect(source).toContain("export interface ProcOutput_submitContact");
    expect(source).toContain("export type ViewParams_posts_by_locale");
    expect(source).toMatch(/ViewParams_posts_by_locale[^}]+locale: string;/s);
    expect(source).toContain("export interface ViewRow_posts_by_locale");
    // Required field is non-optional, optional field has `?`
    expect(source).toMatch(/slug: string;\n\s+title\?: string;/);
    // Reserved columns surface on every ViewRow
    expect(source).toContain("status: \"draft\" | \"published\" | \"archived\"");
  });

  it("emits a `type` alias (not an interface) for a non-object top-level schema (#394)", () => {
    const yaml = `apiVersion: cms.mantle.aotter.net/v1
kind: Procedure
metadata: { name: ping }
spec:
  input: { type: string }
  output: { type: object }
  handler: { kind: ref, ref: ping }
`;
    const { manifests } = parseManifests(yaml);
    const { source } = EmitTypesUseCase.run({ manifests, namespace: "Test" });
    // `export interface ProcInput_ping string` would be a TS syntax error.
    expect(source).toContain("export type ProcInput_ping = string;");
    expect(source).not.toMatch(/export interface ProcInput_ping\s+string/);
  });
});
