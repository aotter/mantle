import { describe, expect, it } from "vitest";
import { InMemoryHandlerRegistry } from "../src/domain/port/HandlerRegistry.js";
import {
  BootValidationError,
  ValidateBootUseCase,
} from "../src/usecase/boot/ValidateBootUseCase.js";
import {
  makeBuiltinProcedure,
  makeHttpTrigger,
  makeLifecycleTrigger,
  makeProcedure,
  postsSchema,
} from "./fakes/manifests.js";

describe("ValidateBootUseCase", () => {
  it("passes when every Procedure handler ref is registered", () => {
    const reg = new InMemoryHandlerRegistry();
    reg.register("echoHandler", () => ({ ok: true }));
    const result = new ValidateBootUseCase().execute({
      manifests: [makeProcedure()],
      registry: reg,
    });
    expect(result.ok).toBe(true);
  });

  it("rejects invalid Schema index declarations with boot diagnostics", () => {
    const manifest = postsSchema();
    const result = new ValidateBootUseCase().execute({
      manifests: [{
        ...manifest,
        spec: { ...manifest.spec, indexes: [["missing"]] },
      }],
      registry: new InMemoryHandlerRegistry(),
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics[0]).toMatchObject({
      code: "SCHEMA_INDEX_FIELD_UNKNOWN",
      phase: "boot",
    });
  });

  it("rejects missing, self-referencing, builtin, and chained guard Procedures", () => {
    const reg = new InMemoryHandlerRegistry();
    reg.register("echoHandler", () => ({ ok: true }));
    const result = new ValidateBootUseCase().execute({
      manifests: [
        postsSchema(),
        makeProcedure({ name: "missing", guard: "ghost" }),
        makeProcedure({ name: "self", guard: "self" }),
        makeBuiltinProcedure({ name: "builtinGuard", schema: "posts" }),
        makeProcedure({ name: "usesBuiltin", guard: "builtinGuard" }),
        makeProcedure({ name: "leaf" }),
        makeProcedure({ name: "chainedGuard", guard: "leaf" }),
        makeProcedure({ name: "usesChain", guard: "chainedGuard" }),
      ],
      registry: reg,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const codes = result.diagnostics.map((d) => d.code);
    expect(codes).toContain("GUARD_PROCEDURE_UNKNOWN");
    expect(codes).toContain("GUARD_SELF_REFERENCE");
    expect(codes).toContain("GUARD_PROCEDURE_BUILTIN");
    expect(codes).toContain("GUARD_CHAIN_NOT_ALLOWED");
  });

  it("fails with HANDLER_NOT_REGISTERED when ref is missing", () => {
    const reg = new InMemoryHandlerRegistry();
    const result = new ValidateBootUseCase().execute({
      manifests: [makeProcedure({ handlerRef: "missing" })],
      registry: reg,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics[0]?.code).toBe("HANDLER_NOT_REGISTERED");
  });

  it("fails with TRIGGER_TARGET_PROCEDURE_UNKNOWN when target doesn't resolve", () => {
    const reg = new InMemoryHandlerRegistry();
    reg.register("echoHandler", () => ({ ok: true }));
    const result = new ValidateBootUseCase().execute({
      manifests: [
        makeProcedure(),
        makeHttpTrigger({ procedure: "ghost", path: "/api/x" }),
      ],
      registry: reg,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const codes = result.diagnostics.map((d) => d.code);
    expect(codes).toContain("TRIGGER_TARGET_PROCEDURE_UNKNOWN");
  });

  it("fails with TRIGGER_PATH_COLLISION when two http triggers share method+path", () => {
    const reg = new InMemoryHandlerRegistry();
    reg.register("echoHandler", () => ({ ok: true }));
    const result = new ValidateBootUseCase().execute({
      manifests: [
        makeProcedure({ name: "a", handlerRef: "echoHandler" }),
        makeProcedure({ name: "b", handlerRef: "echoHandler" }),
        makeHttpTrigger({ name: "ta", procedure: "a", path: "/api/dup" }),
        makeHttpTrigger({ name: "tb", procedure: "b", path: "/api/dup" }),
      ],
      registry: reg,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const codes = result.diagnostics.map((d) => d.code);
    expect(codes).toContain("TRIGGER_PATH_COLLISION");
  });

  it("fails with TRIGGER_PATH_INVALID when http trigger path lacks /api/ prefix", () => {
    const reg = new InMemoryHandlerRegistry();
    reg.register("echoHandler", () => ({ ok: true }));
    const result = new ValidateBootUseCase().execute({
      manifests: [
        makeProcedure(),
        makeHttpTrigger({ procedure: "echo", path: "/contact" }),
      ],
      registry: reg,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const codes = result.diagnostics.map((d) => d.code);
    expect(codes).toContain("TRIGGER_PATH_INVALID");
  });

  it("fails with MCP_TOOL_NAME_COLLISION when a Procedure mangles to a built-in MCP tool (#281)", () => {
    const reg = new InMemoryHandlerRegistry();
    reg.register("echoHandler", () => ({ ok: true }));
    // Procedure named "list-entries" mangles to "list_entries", which
    // is a built-in MCP tool. Reject at boot — without this gate the
    // dispatcher's name lookup would silently route to the procedure
    // and shadow the built-in.
    const result = new ValidateBootUseCase().execute({
      manifests: [makeProcedure({ name: "list-entries" })],
      registry: reg,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const collision = result.diagnostics.find((d) => d.code === "MCP_TOOL_NAME_COLLISION");
    expect(collision).toBeDefined();
    expect(collision?.message).toMatch(/built-in MCP tool/);
  });

  it("fails with MCP_TOOL_NAME_COLLISION when a Procedure starts with a reserved tool-name prefix (#281)", () => {
    const reg = new InMemoryHandlerRegistry();
    reg.register("echoHandler", () => ({ ok: true }));
    const result = new ValidateBootUseCase().execute({
      manifests: [makeProcedure({ name: "create-draft-shenanigan" })],
      registry: reg,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const collision = result.diagnostics.find((d) => d.code === "MCP_TOOL_NAME_COLLISION");
    expect(collision).toBeDefined();
    expect(collision?.message).toMatch(/reserved tool-name prefix/);
  });

  it("fails with MCP_TOOL_NAME_COLLISION when a Procedure mangles to an existing Schema's tool segment (#281)", () => {
    const reg = new InMemoryHandlerRegistry();
    reg.register("echoHandler", () => ({ ok: true }));
    const result = new ValidateBootUseCase().execute({
      manifests: [postsSchema(), makeProcedure({ name: "posts" })],
      registry: reg,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const collision = result.diagnostics.find((d) => d.code === "MCP_TOOL_NAME_COLLISION");
    expect(collision).toBeDefined();
    expect(collision?.message).toMatch(/Schema 'posts'/);
  });

  it("fails with MCP_TOOL_NAME_COLLISION for every schema-derived tool prefix (#281)", () => {
    const reg = new InMemoryHandlerRegistry();
    reg.register("echoHandler", () => ({ ok: true }));
    for (const name of [
      "update-draft-x",
      "create-record-x",
      "update-record-x",
      "query-view-x",
    ]) {
      const r = new ValidateBootUseCase().execute({
        manifests: [makeProcedure({ name })],
        registry: reg,
      });
      expect(r.ok).toBe(false);
      if (r.ok) continue;
      const collision = r.diagnostics.find((d) => d.code === "MCP_TOOL_NAME_COLLISION");
      expect(collision?.message).toMatch(/reserved tool-name prefix/);
    }
  });

  it("fails with MCP_TOOL_NAME_COLLISION when two Procedures mangle to the same tool name (#281)", () => {
    const reg = new InMemoryHandlerRegistry();
    reg.register("echoHandler", () => ({ ok: true }));
    const result = new ValidateBootUseCase().execute({
      manifests: [
        makeProcedure({ name: "restock-sku" }),
        makeProcedure({ name: "restock_sku" }),
      ],
      registry: reg,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const collision = result.diagnostics.find((d) => d.code === "MCP_TOOL_NAME_COLLISION");
    expect(collision?.message).toMatch(/Procedure 'restock-sku'/);
  });

  it("does NOT flag the same Schema appearing twice (idempotent dedupe) (#281 regression guard)", () => {
    const reg = new InMemoryHandlerRegistry();
    reg.register("echoHandler", () => ({ ok: true }));
    const result = new ValidateBootUseCase().execute({
      manifests: [postsSchema(), postsSchema(), makeProcedure({ name: "echo" })],
      registry: reg,
    });
    // postsSchema() returns the same Schema content twice — that's a
    // duplicate in the manifest set, not a tool-name collision. The
    // collision check must skip it (preserves pre-#281 behavior).
    expect(result.ok).toBe(true);
  });

  it("passes when Procedure name is unique and outside the reserved namespace (#281)", () => {
    const reg = new InMemoryHandlerRegistry();
    reg.register("echoHandler", () => ({ ok: true }));
    const result = new ValidateBootUseCase().execute({
      manifests: [postsSchema(), makeProcedure({ name: "restock-sku" })],
      registry: reg,
    });
    expect(result.ok).toBe(true);
  });

  it("assert() throws BootValidationError on failure", () => {
    const reg = new InMemoryHandlerRegistry();
    expect(() =>
      new ValidateBootUseCase().assert({
        manifests: [makeProcedure({ handlerRef: "missing" })],
        registry: reg,
      }),
    ).toThrow(BootValidationError);
  });

  it("Schema with localized: true fails when siteLocales is empty", () => {
    const reg = new InMemoryHandlerRegistry();
    const localizedSchema = {
      ...postsSchema(),
      spec: { ...postsSchema().spec, localized: true },
    };
    const result = new ValidateBootUseCase().execute({
      manifests: [localizedSchema],
      registry: reg,
      siteLocales: [],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const codes = result.diagnostics.map((d) => d.code);
    expect(codes).toContain("SCHEMA_LOCALIZED_REQUIRES_SITE_LOCALES");
  });

  it("accepts a lifecycle Trigger pointing at a known Schema (4.2 wired)", () => {
    const reg = new InMemoryHandlerRegistry();
    reg.register("captchaCheck", () => ({ ok: true }));
    const result = new ValidateBootUseCase().execute({
      manifests: [
        postsSchema(),
        makeProcedure({ name: "captchaCheck", handlerRef: "captchaCheck" }),
        makeLifecycleTrigger({
          procedure: "captchaCheck",
          schema: "posts",
          on: ["before_create"],
          errorPolicy: "abort",
        }),
      ],
      registry: reg,
    });
    expect(result.ok).toBe(true);
  });

  it("emits LIFECYCLE_SCHEMA_UNKNOWN when lifecycle Trigger watches an unknown Schema", () => {
    const reg = new InMemoryHandlerRegistry();
    reg.register("captchaCheck", () => ({ ok: true }));
    const result = new ValidateBootUseCase().execute({
      manifests: [
        postsSchema(),
        makeProcedure({ name: "captchaCheck", handlerRef: "captchaCheck" }),
        makeLifecycleTrigger({
          procedure: "captchaCheck",
          schema: "ghost",
          on: ["before_create"],
        }),
      ],
      registry: reg,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const codes = result.diagnostics.map((d) => d.code);
    expect(codes).toContain("LIFECYCLE_SCHEMA_UNKNOWN");
  });

  it("accepts a builtin Procedure pointing at a known Schema (4.3 wired)", () => {
    const reg = new InMemoryHandlerRegistry();
    const result = new ValidateBootUseCase().execute({
      manifests: [postsSchema(), makeBuiltinProcedure({ schema: "posts", op: "create" })],
      registry: reg,
    });
    expect(result.ok).toBe(true);
  });

  it("emits BUILTIN_HANDLER_SCHEMA_UNKNOWN when builtin targets unknown Schema", () => {
    const reg = new InMemoryHandlerRegistry();
    const result = new ValidateBootUseCase().execute({
      manifests: [postsSchema(), makeBuiltinProcedure({ schema: "ghost", op: "create" })],
      registry: reg,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const codes = result.diagnostics.map((d) => d.code);
    expect(codes).toContain("BUILTIN_HANDLER_SCHEMA_UNKNOWN");
  });
});
