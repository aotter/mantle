import {
  linkManifestSet,
  parseManifestSources,
  type LinkedManifestSet,
} from "@aotter/mantle-spec";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  compileRuntimePlan,
  type RuntimePlan,
} from "../src/domain/service/RuntimePlanCompiler.js";

describe("compileRuntimePlan", () => {
  it("snapshots the #662 characterization corpus", () => {
    const source = readFileSync(
      new URL("../../mantle-spec/test/fixtures/pipeline-v0.1/valid.yaml", import.meta.url),
      "utf8",
    );

    expect(compile(parse(source, "ignored/source.yaml"))).toMatchSnapshot();
  });

  it("has a stable semantic fingerprint across formatting and source identity", () => {
    const first = compile(parse(`apiVersion: cms.mantle.aotter.net/v1
kind: Schema
metadata: { name: posts }
spec:
  title: Posts
  schema: { type: object, properties: { slug: { type: string } } }
`, "memory:first"));
    const second = compile(parse(`kind: Schema
apiVersion: cms.mantle.aotter.net/v1
spec:
  schema:
    properties:
      slug:
        type: string
    type: object
  title: Posts
metadata:
  name: posts
`, "elsewhere/second.yaml"));

    expect(first.semanticFingerprint).toBe(second.semanticFingerprint);
    expect(first).toEqual(second);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(JSON.stringify(first)).not.toContain("memory:first");
    expect(compile(parse(`apiVersion: cms.mantle.aotter.net/v1
kind: Schema
metadata: { name: articles }
spec:
  title: Articles
  schema: { type: object, properties: { slug: { type: string } } }
`)).semanticFingerprint).not.toBe(first.semanticFingerprint);
  });

  it("compiles resolved lookups, auth, routes, MCP, lifecycle, and logical Views once", () => {
    const plan = compile(parse(richManifest));

    expect(plan.version).toBe(1);
    expect(Object.keys(plan.schemas)).toEqual(["posts"]);
    expect(plan.procedures["write"]?.guard).toBe("authorize");
    expect(plan.procedures["write"]?.builtinSchema).toBe("posts");
    expect(plan.views["recent"]?.authorization?.all).toEqual(["ctx.user"]);
    expect(plan.views["recent"]?.query).toMatchObject({
      kind: "declarative",
      from: "posts",
      orderBy: [{ field: "createdAt", direction: "desc" }],
    });
    expect(plan.views["native"]?.query).toEqual({
      kind: "native",
      dialect: "sqlite",
      statement: "SELECT id FROM entries",
    });
    expect(plan.lifecycleHooks).toEqual([{
      schema: "posts",
      hook: "after_create",
      triggerNames: ["010-audit", "020-notify"],
    }]);
    expect(plan.httpRoutes).toEqual([{
      trigger: "write-http",
      method: "POST",
      path: "/api/write",
      procedure: "write",
    }]);
    expect(plan.mcpTools).toContainEqual({
      name: "create_record_posts",
      ownerKind: "Schema",
      ownerName: "posts",
      surface: "staff",
    });
    expect(plan.mcpTools).toContainEqual({
      name: "write",
      ownerKind: "Procedure",
      ownerName: "write",
      surface: "public",
    });
  });

  it("is deeply frozen and contains only serializable values", () => {
    const plan = compile(parse(richManifest));
    const visit = (value: unknown): void => {
      if (!value || typeof value !== "object") {
        expect(typeof value).not.toBe("function");
        return;
      }
      expect(value).not.toBeInstanceOf(Map);
      expect(Object.isFrozen(value)).toBe(true);
      for (const child of Object.values(value)) visit(child);
    };

    visit(plan);
    expect(() => JSON.stringify(plan)).not.toThrow();
  });
});

function parse(text: string, sourceId = "memory:plan"): LinkedManifestSet {
  const parsed = parseManifestSources({ sources: [{ sourceId, text }] });
  if (!parsed.ok) throw new Error(parsed.diagnostics.map((item) => item.message).join("\n"));
  const linked = linkManifestSet(parsed.value);
  if (!linked.ok) throw new Error(linked.diagnostics.map((item) => item.message).join("\n"));
  return linked.value;
}

function compile(linked: LinkedManifestSet): RuntimePlan {
  const compiled = compileRuntimePlan(linked);
  if (!compiled.ok) throw new Error("expected compiled plan");
  return compiled.value;
}

const richManifest = `apiVersion: cms.mantle.aotter.net/v1
kind: Schema
metadata: { name: posts }
spec:
  title: Posts
  lifecycle: operational
  schema:
    type: object
    properties:
      title: { type: string }
      createdAt: { type: number }
---
apiVersion: cms.mantle.aotter.net/v1
kind: Procedure
metadata: { name: authorize }
spec:
  input: { type: object }
  output: { type: object }
  handler: { kind: ref, ref: authorize }
---
apiVersion: cms.mantle.aotter.net/v1
kind: Procedure
metadata: { name: write }
spec:
  input: { type: object }
  output: { type: object }
  handler: { kind: builtin, op: create, schema: posts }
  requires: { guard: { procedure: authorize } }
---
apiVersion: cms.mantle.aotter.net/v1
kind: View
metadata: { name: recent }
spec:
  surface: public
  from: posts
  orderBy: [{ field: createdAt, direction: desc }]
  requires: { auth: { all: [ctx.user] } }
---
apiVersion: cms.mantle.aotter.net/v1
kind: View
metadata: { name: native }
spec:
  surface: staff
  sql: SELECT id FROM entries
---
apiVersion: cms.mantle.aotter.net/v1
kind: Trigger
metadata: { name: 020-notify }
spec:
  source: { kind: lifecycle, schema: posts, on: [after_create] }
  target: { procedure: write }
---
apiVersion: cms.mantle.aotter.net/v1
kind: Trigger
metadata: { name: 010-audit }
spec:
  source: { kind: lifecycle, schema: posts, on: [after_create] }
  target: { procedure: write }
---
apiVersion: cms.mantle.aotter.net/v1
kind: Trigger
metadata: { name: write-http }
spec:
  source: { kind: http, method: POST, path: /api/write }
  target: { procedure: write }
---
apiVersion: cms.mantle.aotter.net/v1
kind: Trigger
metadata: { name: write-mcp }
spec:
  source: { kind: mcp, surface: public }
  target: { procedure: write }
`;
