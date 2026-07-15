import {
  DiagnosticError,
  firstZodIssueAsJsonPointer,
  jsonSchemaToZod,
  makeDiagnostic,
  readJsonPointer,
  type Diagnostic,
  type Phase,
  type ProcedureManifest,
} from "@aotter/mantle-spec";
import type { ZodType } from "zod";
import { evaluateAuthAll } from "../../domain/service/AuthPredicateEvaluator.js";
import type { HandlerRegistry } from "../../domain/port/HandlerRegistry.js";
import type {
  InvokeProcedureRequest,
  InvokeProcedureResponse,
} from "../dto/procedure/index.js";
import type { InvokeBuiltinUseCase } from "./InvokeBuiltinUseCase.js";

/**
 * `InvokeProcedureUseCase` — in-process invocation of a Procedure.
 * HTTP-agnostic — the adapter's mount layer wraps this to map to/from
 * `Request` / `Response`. The test harness exercises the same entry
 * point.
 *
 * Order of operations:
 *   1. Evaluate `requires.auth.all` predicates against `ctx`. Deny ⇒
 *      `UNAUTHENTICATED` or `AUTH_DENIED`.
 *   2. Validate `input` against the Procedure's `input` JSON Schema.
 *      Fail ⇒ `INPUT_VALIDATION_FAILED` (first zod issue).
 *   3. Invoke an optional guard Procedure with validated input and the
 *      same caller context. Any failure denies the target.
 *   4. Dispatch by `handler.kind`:
 *      - `ref`: resolve in registry, call (`InvokeFailure` → unwrap;
 *        other throws → `INTERNAL_ERROR`).
 *      - `builtin`: delegate to `InvokeBuiltinUseCase` (project +
 *        stamp + chokepoint write per POC ADR-0014). When no builtin
 *        collaborator was injected (test paths, ref-only runtimes) the
 *        use case returns `HANDLER_BUILTIN_NOT_IN_V010`.
 *   5. Validate the result against the `output` schema. Fail ⇒
 *      `OUTPUT_VALIDATION_FAILED` (handler / builtin bug).
 */
/**
 * Throwable carrier for handlers that want to surface a structured
 * Diagnostic without going through the generic `INTERNAL_ERROR`
 * envelope. The use case catches it and converts to an
 * `{ ok: false, diagnostic }` return. Lives here (not in
 * `usecase/dto/`) because it's a runtime value, not a DTO type.
 */
export class InvokeFailure extends Error {
  constructor(public readonly diagnostic: Diagnostic) {
    super(diagnostic.message);
    this.name = "InvokeFailure";
  }
}

export class InvokeProcedureUseCase {
  // Per-Procedure compiled zod schemas. zod composition is pure
  // object-tree assembly (no `new Function`) — Workers-CSP-safe.
  // Cached per use-case instance because `jsonSchemaToZod` walks the
  // JSON Schema once per call. Two runtimes with manifests sharing a
  // procedure name + different schemas will get separate caches
  // because the runtime owns the use case instance.
  private readonly inputCache = new Map<string, ZodType>();
  private readonly outputCache = new Map<string, ZodType>();

  constructor(
    private readonly registry: HandlerRegistry,
    private readonly builtin?: InvokeBuiltinUseCase,
    private readonly proceduresByName: ReadonlyMap<string, ProcedureManifest> = new Map(),
  ) {}

  async execute<O = unknown>(request: InvokeProcedureRequest): Promise<InvokeProcedureResponse<O>> {
    return this.executeInternal(request, true);
  }

  private async executeInternal<O = unknown>(
    request: InvokeProcedureRequest,
    allowGuard: boolean,
  ): Promise<InvokeProcedureResponse<O>> {
    const { procedure, input, ctx } = request;
    const phase: Phase = "runtime";
    const procPath = request.pathPrefix ?? `manifest:Procedure/${procedure.metadata.name}`;

    // 1. Auth.
    const denial = evaluateAuthAll(procedure.spec.requires, ctx, procPath, phase);
    if (denial) return { ok: false, diagnostic: denial };

    // 2. Input validation.
    const inputValidator = this.compileInput(procedure);
    const inputResult = inputValidator.safeParse(input);
    if (!inputResult.success) {
      const { instancePath, message } = firstZodIssueAsJsonPointer(inputResult.error);
      return {
        ok: false,
        diagnostic: makeDiagnostic({
          code: "INPUT_VALIDATION_FAILED",
          phase,
          severity: "error",
          path: `${procPath}#/input${instancePath}`,
          value: readJsonPointer(input, instancePath),
          expected: message,
        }),
      };
    }

    // 3. Dynamic guard. It receives only target input that passed the
    // target schema, shares the same caller context, and runs through
    // this exact auth/input/handler/output pipeline. Boot rejects guard
    // chains; allowGuard is defense-in-depth for boot-bypass paths.
    const guardName = procedure.spec.requires?.guard?.procedure;
    if (guardName) {
      if (!allowGuard) {
        return {
          ok: false,
          diagnostic: makeDiagnostic({
            code: "GUARD_CHAIN_NOT_ALLOWED",
            phase,
            severity: "error",
            path: `${procPath}#/requires/guard/procedure`,
            value: guardName,
            expected: "an unguarded Procedure",
          }),
        };
      }
      const guard = this.proceduresByName.get(guardName);
      if (!guard) {
        return {
          ok: false,
          diagnostic: makeDiagnostic({
            code: "GUARD_PROCEDURE_UNKNOWN",
            phase,
            severity: "error",
            path: `${procPath}#/requires/guard/procedure`,
            value: guardName,
            expected: "name of a declared Procedure",
          }),
        };
      }
      if (guard.metadata.name === procedure.metadata.name) {
        return {
          ok: false,
          diagnostic: makeDiagnostic({
            code: "GUARD_SELF_REFERENCE",
            phase,
            severity: "error",
            path: `${procPath}#/requires/guard/procedure`,
            value: guardName,
            expected: "a different, unguarded Procedure",
          }),
        };
      }
      if (guard.spec.handler.kind !== "ref") {
        return {
          ok: false,
          diagnostic: makeDiagnostic({
            code: "GUARD_PROCEDURE_BUILTIN",
            phase,
            severity: "error",
            path: `${procPath}#/requires/guard/procedure`,
            value: guardName,
            expected: "a Procedure with handler.kind: ref",
          }),
        };
      }
      const guardResult = await this.executeInternal(
        {
          procedure: guard,
          input: inputResult.data,
          ctx,
          pathPrefix: `${procPath}#/requires/guard/${guardName}`,
        },
        false,
      );
      if (!guardResult.ok) return guardResult;
    }

    // 4. Dispatch by handler kind.
    const handlerBinding = procedure.spec.handler;
    const handlerLabel =
      handlerBinding.kind === "builtin"
        ? `builtin/${handlerBinding.op}`
        : handlerBinding.ref;
    let result: unknown;
    try {
      if (handlerBinding.kind === "builtin") {
        if (!this.builtin) {
          return {
            ok: false,
            diagnostic: makeDiagnostic({
              code: "HANDLER_BUILTIN_NOT_IN_V010",
              phase,
              severity: "error",
              path: `${procPath}#/handler/kind`,
              value: handlerBinding.kind,
              expected: "InvokeBuiltinUseCase wired into the runtime",
              message: `Procedure '${procedure.metadata.name}' uses handler.kind: 'builtin' but the runtime was constructed without an InvokeBuiltinUseCase.`,
            }),
          };
        }
        result = await this.builtin.run({
          procedure,
          validatedInput: inputResult.data as Record<string, unknown>,
          ctx,
        });
      } else {
        const handler = this.registry.get(handlerBinding.ref);
        if (!handler) {
          return {
            ok: false,
            diagnostic: makeDiagnostic({
              code: "HANDLER_NOT_REGISTERED",
              phase,
              severity: "error",
              path: `${procPath}#/handler/ref`,
              value: handlerBinding.ref,
              expected: "a ref registered via the handlers option / sdk.registerHandler",
              candidates: this.registry.list(),
            }),
          };
        }
        result = await handler(inputResult.data, ctx);
      }
    } catch (err) {
      if (err instanceof InvokeFailure) {
        return { ok: false, diagnostic: err.diagnostic };
      }
      if (err instanceof DiagnosticError) {
        return { ok: false, diagnostic: err.diagnostic };
      }
      const msg = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        diagnostic: makeDiagnostic({
          code: "INTERNAL_ERROR",
          phase,
          severity: "error",
          path: procPath,
          expected: "handler completes without throwing",
          message: `Handler '${handlerLabel}' threw: ${msg}`,
        }),
      };
    }

    // 5. Output validation.
    const outputValidator = this.compileOutput(procedure);
    const outputResult = outputValidator.safeParse(result);
    if (!outputResult.success) {
      const { instancePath, message } = firstZodIssueAsJsonPointer(outputResult.error);
      return {
        ok: false,
        diagnostic: makeDiagnostic({
          code: "OUTPUT_VALIDATION_FAILED",
          phase,
          severity: "error",
          path: `${procPath}#/output${instancePath}`,
          value: readJsonPointer(result, instancePath),
          expected: message,
          message: `Handler '${handlerLabel}' returned a value that does not match its declared output schema. This is a handler bug.`,
        }),
      };
    }

    return { ok: true, data: result as O };
  }

  private compileInput(p: ProcedureManifest): ZodType {
    const k = p.metadata.name;
    let v = this.inputCache.get(k);
    if (!v) {
      v = jsonSchemaToZod(p.spec.input);
      this.inputCache.set(k, v);
    }
    return v;
  }

  private compileOutput(p: ProcedureManifest): ZodType {
    const k = p.metadata.name;
    let v = this.outputCache.get(k);
    if (!v) {
      v = jsonSchemaToZod(p.spec.output);
      this.outputCache.set(k, v);
    }
    return v;
  }
}
