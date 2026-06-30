import {
  canTransition,
  DiagnosticError,
  runtimeDiagnostic,
  type SchemaManifest,
} from "@aotter/mantle-spec";
import type { EntryRow } from "../../domain/model/EntryRow.js";
import type { HandlerContext } from "../../domain/model/HandlerContext.js";
import type { Clock } from "../../domain/port/Clock.js";
import type { EntryRepository } from "../../domain/port/EntryRepository.js";
import type { IdGenerator } from "../../domain/port/IdGenerator.js";
import type { SiteConfigRepository } from "../../domain/port/SiteConfigRepository.js";
import {
  projectAndStamp,
  projectUpdateAndStamp,
} from "../../domain/service/BuiltinProjector.js";
import { assertEntryWritable } from "../../domain/service/io/EntryWriteGuard.js";
import type { InvokeBuiltinRequest } from "../dto/procedure/index.js";

/**
 * `InvokeBuiltinUseCase` — executes the `handler.kind: builtin` op
 * (POC ADR-0014). The four ops map 1:1 to the entry-writer chokepoint:
 *
 *   - `create` → `entries.create({ ..., status: 'draft' })` with a
 *     generated id. Input is projected through
 *     `domain/service/BuiltinProjector.projectAndStamp` so only
 *     Schema-declared keys land in `data` and `x-mantle-bind` fields are
 *     server-stamped from `ctx`.
 *   - `update` → `entries.update`. Caller supplies `id` +
 *     `expectedVersion` in the input; OCC enforced at the chokepoint.
 *   - `upsert` → `update` if `input.id` resolves, else `create`.
 *   - `delete` → `entries.delete({ id })`.
 *
 * Pre-projection original input is forwarded to the chokepoint via
 * `originalInput`, so lifecycle hook handlers can read side-channel
 * fields (CAPTCHA tokens, etc.) declared on the Procedure input but
 * not on the Schema.
 *
 * Auth + input/output validation happen upstream in
 * `InvokeProcedureUseCase`. This use case trusts its `validatedInput`.
 */
export class InvokeBuiltinUseCase {
  constructor(
    private readonly entries: EntryRepository,
    private readonly schemasByName: ReadonlyMap<string, SchemaManifest>,
    private readonly clock: Clock,
    private readonly idgen: IdGenerator,
    private readonly siteConfig?: SiteConfigRepository,
  ) {}

  async run(request: InvokeBuiltinRequest): Promise<unknown> {
    const handler = request.procedure.spec.handler;
    if (handler.kind !== "builtin") {
      throw new DiagnosticError(
        runtimeDiagnostic({
          code: "INTERNAL_ERROR",
          severity: "error",
          path: `usecase/InvokeBuiltin/${request.procedure.metadata.name}`,
          value: handler.kind,
          expected: "handler.kind: 'builtin' (router should have filtered ref)",
          message: `InvokeBuiltinUseCase received handler.kind '${handler.kind}'. The router in InvokeProcedureUseCase should have filtered ref handlers — this is a wiring bug.`,
        }),
      );
    }

    const schema = this.schemasByName.get(handler.schema);
    if (!schema) {
      throw new DiagnosticError(
        runtimeDiagnostic({
          code: "BUILTIN_HANDLER_SCHEMA_UNKNOWN",
          severity: "error",
          path: `usecase/InvokeBuiltin/${request.procedure.metadata.name}#/handler/schema`,
          value: handler.schema,
          expected: "name of a declared Schema",
          candidates: [...this.schemasByName.keys()],
          message: `Procedure '${request.procedure.metadata.name}' (handler.kind: builtin) targets unknown Schema '${handler.schema}'. (Boot validator should have caught this.)`,
        }),
      );
    }

    const now = this.clock.now();
    const input = request.validatedInput;

    switch (handler.op) {
      case "create":
        return this.opCreate(schema, input, request.ctx, now);
      case "update":
        return this.opUpdate(schema, input, request.ctx, now);
      case "upsert":
        return this.opUpsert(schema, input, request.ctx, now);
      case "delete":
        return this.opDelete(schema, input, request.ctx);
      case "archive":
        return this.opArchive(schema, input, request.ctx, now);
      default: {
        const _exhaustive: never = handler.op;
        throw new DiagnosticError(
          runtimeDiagnostic({
            code: "INTERNAL_ERROR",
            severity: "error",
            path: `usecase/InvokeBuiltin/${request.procedure.metadata.name}#/handler/op`,
            value: _exhaustive,
            expected: "one of BUILTIN_OPS",
            message: `Builtin op '${String(_exhaustive)}' is in BUILTIN_OPS but not handled by InvokeBuiltinUseCase. Add a case branch.`,
          }),
        );
      }
    }
  }

  private async opCreate(
    schema: SchemaManifest,
    input: Record<string, unknown>,
    ctx: HandlerContext,
    now: number,
  ): Promise<EntryRow> {
    const opPath = `usecase/InvokeBuiltin/${schema.metadata.name}/create`;
    const data = projectAndStamp({ schema, input, ctx, clockNow: now });
    await assertEntryWritable({
      opPath,
      entries: this.entries,
      schema,
      data,
      siteConfig: this.siteConfig,
    });
    return this.entries.create({
      id: this.idgen.next(),
      collection: schema.metadata.name,
      status: "draft",
      data,
      authorId: ctx.user?.id ?? null,
      now,
      hookContext: ctx,
      originalInput: input,
    });
  }

  private async opUpdate(
    schema: SchemaManifest,
    input: Record<string, unknown>,
    ctx: HandlerContext,
    now: number,
    preloaded?: EntryRow,
  ): Promise<EntryRow> {
    const opPath = `usecase/InvokeBuiltin/${schema.metadata.name}/update`;
    const id = requireField(input, "id", "string");
    const expectedVersion = requireField(input, "expectedVersion", "number");
    // Read the existing row and PATCH it. The create projector
    // (`projectAndStamp`) would drop every Schema field the caller
    // omitted and re-stamp `x-mantle-bind` fields (author → current
    // caller, `now` → this edit) — silent data loss. Mirror
    // UpdateDraftUseCase: merge via `projectUpdateAndStamp` so omitted
    // fields and server-stamped values (author, created-at) survive.
    const existing = preloaded ?? (await this.entries.get(id));
    if (!existing) {
      throw new DiagnosticError(
        runtimeDiagnostic({
          code: "NOT_FOUND",
          severity: "error",
          path: `${opPath}/${id}`,
          value: id,
          expected: "id of an existing entry",
          message: `Entry not found: ${id}.`,
        }),
      );
    }
    const data = projectUpdateAndStamp({
      schema,
      existing: existing.data,
      patch: input,
      ctx,
      clockNow: now,
    });
    await assertEntryWritable({
      opPath,
      entries: this.entries,
      schema,
      data,
      excludeId: id,
      siteConfig: this.siteConfig,
    });
    return this.entries.update({
      id,
      collection: schema.metadata.name,
      expectedVersion,
      data,
      now,
      hookContext: ctx,
      originalInput: input,
    });
  }

  private async opUpsert(
    schema: SchemaManifest,
    input: Record<string, unknown>,
    ctx: HandlerContext,
    now: number,
  ): Promise<EntryRow> {
    const id = typeof input["id"] === "string" ? input["id"] : undefined;
    if (id) {
      const existing = await this.entries.get(id);
      if (existing) return this.opUpdate(schema, input, ctx, now, existing);
    }
    return this.opCreate(schema, input, ctx, now);
  }

  private async opDelete(
    schema: SchemaManifest,
    input: Record<string, unknown>,
    ctx: HandlerContext,
  ): Promise<{ readonly removed: boolean }> {
    const id = requireField(input, "id", "string");
    return this.entries.delete({
      id,
      collection: schema.metadata.name,
      hookContext: ctx,
      originalInput: input,
    });
  }

  private async opArchive(
    schema: SchemaManifest,
    input: Record<string, unknown>,
    ctx: HandlerContext,
    now: number,
  ): Promise<EntryRow> {
    const id = requireField(input, "id", "string");
    const existing = await this.entries.get(id);
    if (!existing) {
      throw new DiagnosticError(
        runtimeDiagnostic({
          code: "NOT_FOUND",
          severity: "error",
          path: `builtin:archive/${schema.metadata.name}/${id}`,
          value: id,
          expected: "id of an existing entry",
          message: `Entry not found: ${id}.`,
        }),
      );
    }
    // Mirror ArchiveUseCase: state-machine guard + OCC pinned to the
    // version we just read so guard and chokepoint check the same
    // snapshot.
    if (!canTransition(schema, existing.status, "archived")) {
      throw new DiagnosticError(
        runtimeDiagnostic({
          code: "CONFLICT",
          severity: "error",
          path: `builtin:archive/${schema.metadata.name}/${id}`,
          value: existing.status,
          expected: "row in a state that allows transition to 'archived'",
          message: `Illegal transition from '${existing.status}' to 'archived'.`,
        }),
      );
    }
    return this.entries.archive({
      id,
      collection: schema.metadata.name,
      expectedVersion: existing.version,
      now,
      hookContext: ctx,
      originalInput: input,
    });
  }
}

function requireField<T extends "string" | "number">(
  input: Record<string, unknown>,
  key: string,
  expected: T,
): T extends "string" ? string : number {
  const v = input[key];
  const ok = expected === "string" ? typeof v === "string" : typeof v === "number" && Number.isFinite(v);
  if (!ok) {
    throw new DiagnosticError(
      runtimeDiagnostic({
        code: "INPUT_VALIDATION_FAILED",
        severity: "error",
        path: `builtin-input/${key}`,
        value: v,
        expected: `${expected} field '${key}' (declare it in Procedure.input.properties so zod validation rejects upstream)`,
        message: `Builtin op requires '${key}' as a ${expected}. Add it to the Procedure's input schema.`,
      }),
    );
  }
  return v as T extends "string" ? string : number;
}
