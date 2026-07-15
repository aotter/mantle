import { describe, expect, it, beforeEach } from "vitest";
import { DiagnosticError, runtimeDiagnostic } from "@aotter/mantle-spec";
import type { HandlerContext } from "../src/domain/model/HandlerContext.js";
import { InMemoryHandlerRegistry } from "../src/domain/port/HandlerRegistry.js";
import {
  InvokeFailure,
  InvokeProcedureUseCase,
} from "../src/usecase/procedure/InvokeProcedureUseCase.js";
import { makeBuiltinProcedure, makeProcedure } from "./fakes/manifests.js";

const anonCtx: HandlerContext = { user: null, staff: null, env: {} };

function fresh(): { reg: InMemoryHandlerRegistry; uc: InvokeProcedureUseCase } {
  const reg = new InMemoryHandlerRegistry();
  return { reg, uc: new InvokeProcedureUseCase(reg) };
}

beforeEach(() => {
  // Each test constructs its own use case so caches are naturally isolated.
});

describe("InvokeProcedureUseCase", () => {
  it("happy path: input validates, handler runs, output validates", async () => {
    const { reg, uc } = fresh();
    reg.register("echoHandler", () => ({ ok: true }));
    const result = await uc.execute({
      procedure: makeProcedure(),
      input: { msg: "hi" },
      ctx: anonCtx,
    });
    expect(result).toEqual({ ok: true, data: { ok: true } });
  });

  it("INPUT_VALIDATION_FAILED when input doesn't match schema", async () => {
    const { reg, uc } = fresh();
    reg.register("echoHandler", () => ({ ok: true }));
    const result = await uc.execute({
      procedure: makeProcedure(),
      input: { msg: 42 },
      ctx: anonCtx,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostic.code).toBe("INPUT_VALIDATION_FAILED");
    expect(result.diagnostic.path).toMatch(/^manifest:Procedure\/echo#\/input/);
  });

  it("HANDLER_NOT_REGISTERED when ref isn't in registry", async () => {
    const { uc } = fresh();
    const result = await uc.execute({
      procedure: makeProcedure({ handlerRef: "missing" }),
      input: { msg: "hi" },
      ctx: anonCtx,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostic.code).toBe("HANDLER_NOT_REGISTERED");
    expect(result.diagnostic.value).toBe("missing");
  });

  it("OUTPUT_VALIDATION_FAILED when handler returns wrong shape", async () => {
    const { reg, uc } = fresh();
    reg.register("echoHandler", () => ({ ok: "yes" }));
    const result = await uc.execute({
      procedure: makeProcedure(),
      input: { msg: "hi" },
      ctx: anonCtx,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostic.code).toBe("OUTPUT_VALIDATION_FAILED");
  });

  it("INTERNAL_ERROR when handler throws an unstructured Error", async () => {
    const { reg, uc } = fresh();
    reg.register("echoHandler", () => {
      throw new Error("boom");
    });
    const result = await uc.execute({
      procedure: makeProcedure(),
      input: { msg: "hi" },
      ctx: anonCtx,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostic.code).toBe("INTERNAL_ERROR");
    expect(result.diagnostic.message).toContain("boom");
  });

  it("InvokeFailure unwrap preserves the structured diagnostic", async () => {
    const { reg, uc } = fresh();
    reg.register("echoHandler", () => {
      throw new InvokeFailure(
        runtimeDiagnostic({
          code: "CONFLICT",
          severity: "error",
          path: "test",
          message: "specific reason",
        }),
      );
    });
    const result = await uc.execute({
      procedure: makeProcedure(),
      input: { msg: "hi" },
      ctx: anonCtx,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostic.code).toBe("CONFLICT");
    expect(result.diagnostic.message).toBe("specific reason");
  });

  it("UNAUTHENTICATED when ctx.user predicate fails for anonymous caller", async () => {
    const { reg, uc } = fresh();
    reg.register("echoHandler", () => ({ ok: true }));
    const result = await uc.execute({
      procedure: makeProcedure({ authPredicates: ["ctx.user"] }),
      input: { msg: "hi" },
      ctx: anonCtx,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostic.code).toBe("UNAUTHENTICATED");
  });

  it("ctx.auth and ctx.auth.scope distinguish verified credentials from insufficient scope", async () => {
    const { reg, uc } = fresh();
    reg.register("echoHandler", () => ({ ok: true }));
    const procedure = makeProcedure({
      authPredicates: ["ctx.auth", { "ctx.auth.scope": "posts:read" }],
    });

    const anonymous = await uc.execute({ procedure, input: { msg: "hi" }, ctx: anonCtx });
    expect(anonymous.ok).toBe(false);
    if (!anonymous.ok) expect(anonymous.diagnostic.code).toBe("UNAUTHENTICATED");

    const insufficient = await uc.execute({
      procedure,
      input: { msg: "hi" },
      ctx: {
        user: null,
        staff: null,
        auth: {
          credential: "api-key",
          credentialId: "key-1",
          clientId: null,
          scopes: [],
        },
        env: {},
      },
    });
    expect(insufficient.ok).toBe(false);
    if (!insufficient.ok) expect(insufficient.diagnostic.code).toBe("AUTH_DENIED");

    const allowed = await uc.execute({
      procedure,
      input: { msg: "hi" },
      ctx: {
        user: null,
        staff: null,
        auth: {
          credential: "api-key",
          credentialId: "key-1",
          clientId: null,
          scopes: ["posts:read"],
        },
        env: {},
      },
    });
    expect(allowed.ok).toBe(true);
  });

  it("runs a guard after target input validation and before the target handler", async () => {
    const reg = new InMemoryHandlerRegistry();
    const calls: string[] = [];
    const guard = makeProcedure({
      name: "requirePaid",
      handlerRef: "requirePaid",
      input: {
        type: "object",
        properties: { msg: { type: "string" } },
        required: ["msg"],
      },
      output: {
        type: "object",
        properties: { ok: { type: "boolean" } },
        required: ["ok"],
      },
    });
    const target = makeProcedure({ guard: "requirePaid" });
    reg.register("requirePaid", (input: { msg: string }) => {
      calls.push(`guard:${input.msg}`);
      return { ok: true };
    });
    reg.register("echoHandler", () => {
      calls.push("target");
      return { ok: true };
    });
    const uc = new InvokeProcedureUseCase(
      reg,
      undefined,
      new Map([
        [guard.metadata.name, guard],
        [target.metadata.name, target],
      ]),
    );

    const invalid = await uc.execute({ procedure: target, input: { msg: 1 }, ctx: anonCtx });
    expect(invalid.ok).toBe(false);
    expect(calls).toEqual([]);

    const result = await uc.execute({ procedure: target, input: { msg: "hi" }, ctx: anonCtx });
    expect(result.ok).toBe(true);
    expect(calls).toEqual(["guard:hi", "target"]);
  });

  it("propagates a guard's ENTITLEMENT_REQUIRED and never calls the target", async () => {
    const reg = new InMemoryHandlerRegistry();
    const guard = makeProcedure({ name: "requirePaid", handlerRef: "requirePaid" });
    const target = makeProcedure({ guard: "requirePaid" });
    let targetCalls = 0;
    reg.register("requirePaid", () => {
      throw new DiagnosticError(
        runtimeDiagnostic({
          code: "ENTITLEMENT_REQUIRED",
          severity: "error",
          path: "site:entitlement",
          message: "payment required",
        }),
      );
    });
    reg.register("echoHandler", () => {
      targetCalls++;
      return { ok: true };
    });
    const uc = new InvokeProcedureUseCase(
      reg,
      undefined,
      new Map([[guard.metadata.name, guard]]),
    );
    const result = await uc.execute({ procedure: target, input: { msg: "hi" }, ctx: anonCtx });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.diagnostic.code).toBe("ENTITLEMENT_REQUIRED");
    expect(targetCalls).toBe(0);
  });

  it.each([
    {
      label: "throws",
      guardHandler: () => {
        throw new Error("guard storage unavailable");
      },
      code: "INTERNAL_ERROR",
    },
    {
      label: "returns output outside its schema",
      guardHandler: () => ({ ok: "not-boolean" }),
      code: "OUTPUT_VALIDATION_FAILED",
    },
  ])("fails closed when a guard $label", async ({ guardHandler, code }) => {
    const reg = new InMemoryHandlerRegistry();
    const guard = makeProcedure({ name: "requirePaid", handlerRef: "requirePaid" });
    const target = makeProcedure({ guard: "requirePaid" });
    let targetCalls = 0;
    reg.register("requirePaid", guardHandler);
    reg.register("echoHandler", () => {
      targetCalls++;
      return { ok: true };
    });
    const uc = new InvokeProcedureUseCase(
      reg,
      undefined,
      new Map([[guard.metadata.name, guard]]),
    );
    const result = await uc.execute({ procedure: target, input: { msg: "hi" }, ctx: anonCtx });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.diagnostic.code).toBe(code);
    expect(targetCalls).toBe(0);
  });

  it("ctx.staff role list passes when staff role is in the list", async () => {
    const { reg, uc } = fresh();
    reg.register("echoHandler", () => ({ ok: true }));
    const result = await uc.execute({
      procedure: makeProcedure({
        authPredicates: [{ "ctx.staff": ["editor", "owner"] }],
      }),
      input: { msg: "hi" },
      ctx: { user: { id: "u1" }, staff: { id: "u1", role: "editor" }, env: {} },
    });
    expect(result.ok).toBe(true);
  });

  it("ctx.staff role list rejects when staff role is not in the list", async () => {
    const { reg, uc } = fresh();
    reg.register("echoHandler", () => ({ ok: true }));
    const result = await uc.execute({
      procedure: makeProcedure({
        authPredicates: [{ "ctx.staff": ["editor", "owner"] }],
      }),
      input: { msg: "hi" },
      ctx: { user: { id: "u1" }, staff: { id: "u1", role: "contributor" }, env: {} },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostic.code).toBe("AUTH_DENIED");
  });

  it("HANDLER_BUILTIN_NOT_IN_V010 if a builtin Procedure reaches Invoke (boot guard bypass)", async () => {
    const { uc } = fresh();
    const result = await uc.execute({
      procedure: makeBuiltinProcedure({ schema: "posts", op: "create" }),
      input: { data: {} },
      ctx: anonCtx,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostic.code).toBe("HANDLER_BUILTIN_NOT_IN_V010");
  });
});
