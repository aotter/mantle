import {
  linkManifestSet,
  parseManifestSources,
} from "@aotter/mantle-spec";
import { describe, expect, it } from "vitest";
import { InMemoryHandlerRegistry } from "../src/domain/port/HandlerRegistry.js";
import {
  BootValidationError,
  ValidateBootUseCase,
} from "../src/usecase/boot/ValidateBootUseCase.js";
import {
  compileRuntimePlan,
  type RuntimePlan,
} from "../src/domain/service/RuntimePlanCompiler.js";

describe("ValidateBootUseCase", () => {
  it("accepts linked semantics when every handler ref is registered", () => {
    const registry = new InMemoryHandlerRegistry();
    registry.register("echoHandler", () => ({ ok: true }));

    expect(new ValidateBootUseCase().execute({
      plan: compilePlan(procedure()),
      registry,
    })).toEqual({ ok: true });
  });

  it("checks handler availability without relinking", () => {
    const result = new ValidateBootUseCase().execute({
      plan: compilePlan(procedure("missing")),
      registry: new InMemoryHandlerRegistry(),
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics[0]).toMatchObject({
      code: "HANDLER_NOT_REGISTERED",
      phase: "boot",
      path: "manifest:Procedure/echo#/spec/handler/ref",
    });
  });

  it("rejects HTTP Triggers under selected reserved route prefixes", () => {
    for (const [path, reservedHttpPathPrefixes] of [
      ["/api/auth/sign-in", ["/api/auth"]],
      ["/api/views/orders", ["/api/views"]],
      ["/api/private-auth/callback", ["/api/private-auth"]],
    ] as const) {
      const registry = new InMemoryHandlerRegistry();
      registry.register("echoHandler", () => ({ ok: true }));
      const result = new ValidateBootUseCase().execute({
        plan: compilePlan(procedure("echoHandler", path)),
        registry,
        reservedHttpPathPrefixes,
      });

      expect(result.ok, path).toBe(false);
      if (result.ok) continue;
      expect(result.diagnostics, path).toContainEqual(expect.objectContaining({
        code: "TRIGGER_PATH_INVALID",
        phase: "boot",
      }));
    }
  });

  it("does not reserve an omitted capability route", () => {
    const registry = new InMemoryHandlerRegistry();
    registry.register("echoHandler", () => ({ ok: true }));

    expect(new ValidateBootUseCase().execute({
      plan: compilePlan(procedure("echoHandler", "/api/views/orders")),
      registry,
      reservedHttpPathPrefixes: [],
    })).toEqual({ ok: true });
  });

  it("checks selected deployment locales", () => {
    const result = new ValidateBootUseCase().execute({
      plan: compilePlan(localizedSchema),
      registry: new InMemoryHandlerRegistry(),
      siteLocales: [],
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      code: "SCHEMA_LOCALIZED_REQUIRES_SITE_LOCALES",
      phase: "boot",
    }));
  });

  it("assert throws BootValidationError on deployment failure", () => {
    expect(() => new ValidateBootUseCase().assert({
      plan: compilePlan(procedure("missing")),
      registry: new InMemoryHandlerRegistry(),
    })).toThrow(BootValidationError);
  });
});

function procedure(handlerRef = "echoHandler", httpPath?: string): string {
  return `apiVersion: cms.mantle.aotter.net/v1
kind: Procedure
metadata: { name: echo }
spec:
  input: { type: object }
  output: { type: object }
  handler: { kind: ref, ref: ${handlerRef} }
${httpPath === undefined ? "" : `---
apiVersion: cms.mantle.aotter.net/v1
kind: Trigger
metadata: { name: echo-http }
spec:
  source: { kind: http, method: POST, path: ${httpPath} }
  target: { procedure: echo }
`}`;
}

const localizedSchema = `apiVersion: cms.mantle.aotter.net/v1
kind: Schema
metadata: { name: posts }
spec:
  title: Posts
  localized: true
  schema: { type: object, properties: { locale: { type: string } } }
`;

function compilePlan(text: string): RuntimePlan {
  const parsed = parseManifestSources({
    sources: [{ sourceId: "memory:boot", text }],
  });
  if (!parsed.ok) throw new Error("expected valid boot fixture");
  const result = linkManifestSet(parsed.value);
  if (!result.ok) throw new Error("expected linked boot fixture");
  const compiled = compileRuntimePlan(result.value);
  if (!compiled.ok) throw new Error("expected compiled boot fixture");
  return compiled.value;
}
