import {
  ContentState,
  DiagnosticError,
  STAFF_ROLES,
  firstZodIssueAsJsonPointer,
  runtimeDiagnostic,
} from "@aotter/mantle-spec";
import { z } from "zod";
import type { HandlerContext } from "../../domain/model/HandlerContext.js";
import {
  DEFERRED_HOOK_ENVELOPE_VERSION,
  type DeferredHookEnvelope,
} from "../../domain/port/DeferredHookDispatcher.js";
import type { RunDeferredHookRequest } from "../dto/lifecycle/index.js";
import type { RunLifecycleHooksUseCase } from "./RunLifecycleHooksUseCase.js";

const nonEmpty = z.string().min(1);
const authSchema = z.object({
  credential: z.enum(["session", "oauth", "api-key", "personal-token"]),
  credentialId: nonEmpty.nullable(),
  clientId: nonEmpty.nullable(),
  scopes: z.array(nonEmpty),
}).strict();

const ctxSnapshotSchema = z.object({
  userId: nonEmpty.nullable(),
  staffId: nonEmpty.nullable(),
  staffRole: z.enum(STAFF_ROLES).nullable(),
  auth: authSchema.nullable(),
}).strict().superRefine((snapshot, ctx) => {
  if ((snapshot.staffId === null) !== (snapshot.staffRole === null)) {
    ctx.addIssue({
      code: "custom",
      path: ["staffId"],
      message: "staffId and staffRole must both be null or both be set",
    });
  }
  if (snapshot.staffId !== null && snapshot.staffId !== snapshot.userId) {
    ctx.addIssue({
      code: "custom",
      path: ["staffId"],
      message: "staffId must match userId",
    });
  }
});

const entrySchema = z.object({
  id: nonEmpty,
  collection: nonEmpty,
  locale: nonEmpty.optional(),
  status: z.enum(ContentState),
  version: z.number().int().positive(),
  data: z.record(z.string(), z.json()),
  authorId: nonEmpty.nullable(),
  createdAt: z.number().finite(),
  updatedAt: z.number().finite(),
}).strict();

const envelopeSchema = z.object({
  version: z.literal(DEFERRED_HOOK_ENVELOPE_VERSION),
  eventId: nonEmpty,
  triggerNames: z.array(nonEmpty).min(1),
  hook: z.enum(["after_create", "after_update", "after_delete", "after_publish"]),
  schema: nonEmpty,
  entry: entrySchema,
  ctxSnapshot: ctxSnapshotSchema.nullable(),
}).strict().superRefine((envelope, ctx) => {
  if (new Set(envelope.triggerNames).size !== envelope.triggerNames.length) {
    ctx.addIssue({
      code: "custom",
      path: ["triggerNames"],
      message: "triggerNames must be unique",
    });
  }
  if (envelope.entry.collection !== envelope.schema) {
    ctx.addIssue({
      code: "custom",
      path: ["entry", "collection"],
      message: "entry.collection must match schema",
    });
  }
});

/**
 * Consume side of deferred lifecycle delivery. Queue bodies are
 * untrusted: the versioned envelope is validated before any field is
 * read, then the original identity snapshot is rebuilt with the
 * consume invocation's fresh adapter bindings.
 *
 * Deferred failures intentionally escape. The Queue adapter converts
 * a throw into retry/DLQ behavior; the already-committed entry
 * mutation is unaffected.
 */
export class RunDeferredHookUseCase {
  constructor(private readonly hooks: Pick<RunLifecycleHooksUseCase, "run">) {}

  async execute(request: RunDeferredHookRequest): Promise<void> {
    const envelope = parseEnvelope(request.envelope);
    const snapshot = envelope.ctxSnapshot;
    const ctx: HandlerContext = {
      user: snapshot?.userId ? { id: snapshot.userId } : null,
      staff: snapshot?.staffId && snapshot.staffRole
        ? { id: snapshot.staffId, role: snapshot.staffRole }
        : null,
      ...(snapshot?.auth ? { auth: snapshot.auth } : {}),
      env: request.env,
    };
    await this.hooks.run({
      eventId: envelope.eventId,
      triggerNames: envelope.triggerNames,
      delivery: "deferred",
      hook: envelope.hook,
      schema: envelope.schema,
      entry: envelope.entry,
      ctx,
    });
  }
}

function parseEnvelope(value: unknown): DeferredHookEnvelope {
  const result = envelopeSchema.safeParse(value);
  if (result.success) return result.data;
  const { instancePath, message } = firstZodIssueAsJsonPointer(result.error);
  throw new DiagnosticError(
    runtimeDiagnostic({
      code: "INPUT_VALIDATION_FAILED",
      severity: "error",
      path: `usecase/RunDeferredHook/envelope${instancePath}`,
      expected: message,
      message: `Deferred lifecycle envelope rejected at '${instancePath || "/"}': ${message}.`,
    }),
  );
}
