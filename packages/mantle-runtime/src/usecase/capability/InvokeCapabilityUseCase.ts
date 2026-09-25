import {
  DiagnosticError,
  meetsRole,
  resolveLifecycle,
  runtimeDiagnostic,
  type Diagnostic,
  type SchemaManifest,
  type StaffRole,
} from "@aotter/mantle-spec";
import type { HandlerContext } from "../../domain/model/HandlerContext.js";
import type { MediaVariantRole } from "../../domain/port/MediaStorage.js";
import {
  CONTENT_LIFECYCLE_ACTIONS,
  UPDATE_ENVELOPE_ARGUMENTS,
  type Capability,
  type CapabilityCatalog,
  type LifecycleAction,
} from "../../domain/service/CapabilityCatalog.js";
import type {
  ArchiveUseCase,
  CreateDraftUseCase,
  DeleteEntryUseCase,
  GetEntryUseCase,
  RequestPublishUseCase,
  UnpublishUseCase,
  UpdateDraftUseCase,
} from "../content/index.js";
import type { CommitMediaUploadUseCase, CreateMediaUploadUseCase } from "../media/index.js";
import type { ExecuteViewUseCase } from "../view/index.js";

/** The use cases a capability can route to. */
export interface CapabilityUseCases {
  readonly getEntry: Pick<GetEntryUseCase, "execute">;
  readonly createDraft: Pick<CreateDraftUseCase, "execute">;
  readonly updateDraft: Pick<UpdateDraftUseCase, "execute">;
  readonly requestPublish: Pick<RequestPublishUseCase, "execute">;
  readonly unpublish: Pick<UnpublishUseCase, "execute">;
  readonly archive: Pick<ArchiveUseCase, "execute">;
  readonly deleteEntry: Pick<DeleteEntryUseCase, "execute">;
  readonly executeView?: Pick<ExecuteViewUseCase, "execute">;
  /** Trigger-backed Procedures route through the runtime's shared Trigger
   *  invocation chokepoint. */
  readonly invokeTrigger?: {
    execute(request: {
      readonly trigger: string;
      readonly input: unknown;
      readonly ctx: HandlerContext;
      readonly pathPrefix?: string;
    }): Promise<
      | { readonly ok: true; readonly data: unknown }
      | { readonly ok: false; readonly diagnostic: Diagnostic }
    >;
  };
  readonly media?: {
    readonly createUpload: Pick<CreateMediaUploadUseCase, "execute">;
    readonly commitUpload: Pick<CommitMediaUploadUseCase, "execute">;
  };
}

export interface InvokeCapabilityRequest {
  readonly name: string;
  readonly args: Readonly<Record<string, unknown>>;
  readonly ctx: HandlerContext;
  /** Diagnostic path prefix naming the transport call, e.g. `MCP <tool>`.
   *  Defaults to the capability name. */
  readonly path?: string;
}

export type CapabilityOutcome =
  | { readonly ok: true; readonly data: unknown }
  | { readonly ok: false; readonly diagnostic: Diagnostic };

/**
 * The single execution entry for catalog capabilities, whatever the
 * transport. It owns the checks that used to live in the MCP dispatcher:
 * the staff role floor, generic-authoring mutability, and argument shape.
 * Everything deeper (Procedure input, View params, entry data, auth
 * predicates, guards, OCC) stays with the use case it routes to, so each
 * value is validated exactly once.
 *
 * Business failures come back as a Diagnostic outcome. Only an unexpected
 * throw escapes, and the transport reports it as an internal error.
 */
export class InvokeCapabilityUseCase {
  private readonly schemas: ReadonlyMap<string, SchemaManifest>;

  constructor(
    private readonly useCases: CapabilityUseCases,
    readonly catalog: CapabilityCatalog,
    schemas: ReadonlyArray<SchemaManifest>,
  ) {
    this.schemas = new Map(schemas.map((schema) => [schema.metadata.name, schema]));
  }

  /** Whether `name` is in the catalog and its use case is bound. */
  serves(name: string): boolean {
    const route = this.catalog.get(name)?.route;
    if (!route) return false;
    switch (route.kind) {
      case "procedure": return this.useCases.invokeTrigger !== undefined;
      case "view": return this.useCases.executeView !== undefined;
      case "mediaCreateUpload":
      case "mediaCommitUpload": return this.useCases.media !== undefined;
      default: return true;
    }
  }

  async execute(request: InvokeCapabilityRequest): Promise<CapabilityOutcome> {
    const path = request.path ?? request.name;
    const capability = this.catalog.get(request.name);
    if (!capability) return fail(unknownCapability(path, request.name));
    try {
      if (capability.minimumRole) assertStaffRole(capability, request.ctx, path);
      return { ok: true, data: await this.route(capability, request.args, request.ctx, path) };
    } catch (error) {
      if (error instanceof DiagnosticError) return fail(error.diagnostic);
      throw error;
    }
  }

  private async route(
    capability: Capability,
    args: Readonly<Record<string, unknown>>,
    ctx: HandlerContext,
    path: string,
  ): Promise<unknown> {
    const route = capability.route;
    switch (route.kind) {
      case "procedure": {
        const invoke = this.useCases.invokeTrigger;
        if (!invoke) throw new DiagnosticError(unknownCapability(path, capability.name));
        const result = await invoke.execute({ trigger: route.trigger, input: args, ctx, pathPrefix: path });
        if (!result.ok) throw new DiagnosticError(result.diagnostic);
        return result.data;
      }
      case "view": {
        const executeView = this.useCases.executeView;
        if (!executeView) throw new DiagnosticError(unknownCapability(path, capability.name));
        const result = await executeView.execute({
          view: route.view,
          options: {
            params: omit(args, VIEW_PAGING_ARGUMENTS),
            page: typeof args["page"] === "number" ? args["page"] : undefined,
            show: typeof args["show"] === "number" ? args["show"] : undefined,
          },
          pathPrefix: path,
          ctx,
        });
        if (!result.ok) throw new DiagnosticError(result.diagnostic);
        return result.result;
      }
      case "read": {
        const collection = stringArgument(args, "collection", path);
        const id = stringArgument(args, "id", path);
        // The advertised enum is a hint; the catalog is the boundary.
        const allowed = (capability.inputSchema["properties"] as { collection?: { enum?: readonly string[] } } | undefined)
          ?.collection?.enum ?? [];
        if (!allowed.includes(collection)) {
          throw invalidArgument(path, "collection", `one of ${allowed.join(", ")}`, collection);
        }
        return this.useCases.getEntry.execute({ id, collection });
      }
      case "lifecycle": {
        const collection = stringArgument(args, "collection", path);
        const id = stringArgument(args, "id", path);
        await this.assertEntryMutable(capability.name, id, collection, path, route.action);
        return this.lifecycleUseCase(route.action).execute({ id, collection, ctx, originalInput: { id } });
      }
      case "create": {
        const data = omit(args, UPDATE_ENVELOPE_ARGUMENTS);
        return this.useCases.createDraft.execute({
          collection: route.collection,
          data,
          authorId: ctx.user?.id ?? null,
          ctx,
          originalInput: data,
        });
      }
      case "update": {
        const id = stringArgument(args, "id", path);
        const expectedVersion = numberArgument(args, "expected_version", path);
        await this.assertEntryMutable(capability.name, id, route.collection, path);
        const data = omit(args, UPDATE_ENVELOPE_ARGUMENTS);
        return this.useCases.updateDraft.execute({
          id,
          collection: route.collection,
          expectedVersion,
          data,
          ctx,
          originalInput: data,
        });
      }
      case "mediaCreateUpload": {
        const media = this.useCases.media;
        if (!media) throw new DiagnosticError(unknownCapability(path, capability.name));
        return media.createUpload.execute({
          filename: stringArgument(args, "filename", path),
          purpose: stringArgument(args, "purpose", path),
          variants: variantsArgument(args, path),
          alt: optionalString(args, "alt"),
          caption: optionalString(args, "caption"),
        });
      }
      case "mediaCommitUpload": {
        const media = this.useCases.media;
        if (!media) throw new DiagnosticError(unknownCapability(path, capability.name));
        return media.commitUpload.execute({
          uploadGroupId: stringArgument(args, "uploadGroupId", path),
          alt: optionalString(args, "alt"),
          caption: optionalString(args, "caption"),
        });
      }
    }
  }

  private lifecycleUseCase(action: LifecycleAction) {
    switch (action) {
      case "requestPublish": return this.useCases.requestPublish;
      case "unpublish": return this.useCases.unpublish;
      case "archive": return this.useCases.archive;
      case "delete": return this.useCases.deleteEntry;
    }
  }

  /** Generic authoring never writes a read-only Schema, and publishing
   *  transitions need a content lifecycle; both use the stored entry's
   *  collection, not the caller's claim. */
  private async assertEntryMutable(
    name: string,
    id: string,
    collection: string,
    path: string,
    action?: LifecycleAction,
  ): Promise<void> {
    const entry = await this.useCases.getEntry.execute({ id, collection });
    const schema = this.schemas.get(entry.collection);
    if (action && CONTENT_LIFECYCLE_ACTIONS.has(action) && (!schema || resolveLifecycle(schema) === "operational")) {
      throw new DiagnosticError(runtimeDiagnostic({
        code: "CONFLICT",
        severity: "error",
        path,
        value: entry.collection,
        expected: "a content lifecycle",
        message: `Tool '${name}' requires a content lifecycle; '${entry.collection}' does not support publishing transitions. Use its declared Procedures.`,
      }));
    }
    if (schema?.spec.schema.readOnly !== true) return;
    throw new DiagnosticError(runtimeDiagnostic({
      code: "CONFLICT",
      severity: "error",
      path,
      value: entry.collection,
      expected: "a Schema without root readOnly: true",
      message: `Schema '${entry.collection}' is read-only on generic authoring surfaces; use its declared Procedures.`,
    }));
  }
}

const VIEW_PAGING_ARGUMENTS: readonly string[] = ["page", "show"];
const VARIANT_ROLES: ReadonlySet<string> = new Set(["primary", "alternate", "fallback"]);

function fail(diagnostic: Diagnostic): CapabilityOutcome {
  return { ok: false, diagnostic };
}

function assertStaffRole(capability: Capability, ctx: HandlerContext, path: string): void {
  const minimumRole = capability.minimumRole as StaffRole;
  const role = ctx.staff?.role;
  if (role && meetsRole(role, minimumRole)) return;
  throw new DiagnosticError(runtimeDiagnostic({
    code: "AUTH_DENIED",
    severity: "error",
    path,
    expected: `${minimumRole} role or higher for the signed-in staff user`,
    message: `Tool '${capability.name}' requires the ${minimumRole} role.`,
  }));
}

function unknownCapability(path: string, name: string): Diagnostic {
  return runtimeDiagnostic({
    code: "NOT_FOUND",
    severity: "error",
    path,
    value: name,
    expected: "a capability served on this surface",
    message: `Unknown capability '${name}'.`,
  });
}

function invalidArgument(path: string, name: string, expected: string, value: unknown): DiagnosticError {
  return new DiagnosticError(runtimeDiagnostic({
    code: "INPUT_VALIDATION_FAILED",
    severity: "error",
    path: `${path}#/arguments/${name}`,
    value,
    expected,
    message: `Argument '${name}' must be ${expected}.`,
  }));
}

function stringArgument(args: Readonly<Record<string, unknown>>, name: string, path: string): string {
  const value = args[name];
  if (typeof value !== "string") throw invalidArgument(path, name, "a string", value);
  return value;
}

function numberArgument(args: Readonly<Record<string, unknown>>, name: string, path: string): number {
  const value = args[name];
  if (typeof value !== "number") throw invalidArgument(path, name, "a number", value);
  return value;
}

function optionalString(args: Readonly<Record<string, unknown>>, name: string): string | undefined {
  const value = args[name];
  return typeof value === "string" ? value : undefined;
}

function variantsArgument(
  args: Readonly<Record<string, unknown>>,
  path: string,
): Array<{ mimeType: string; byteSize: number; role: MediaVariantRole }> {
  const raw = args["variants"];
  const expected = "an array of { mimeType: string, byteSize: positive integer, role: primary | alternate | fallback }";
  if (!Array.isArray(raw)) throw invalidArgument(path, "variants", expected, raw);
  return raw.map((item, index) => {
    const variant = typeof item === "object" && item !== null ? item as Record<string, unknown> : {};
    const { mimeType, byteSize, role } = variant;
    if (
      typeof mimeType !== "string"
      || typeof byteSize !== "number"
      || !Number.isSafeInteger(byteSize)
      || byteSize <= 0
      || typeof role !== "string"
      || !VARIANT_ROLES.has(role)
    ) {
      throw invalidArgument(path, `variants/${index}`, expected, item);
    }
    return { mimeType, byteSize, role: role as MediaVariantRole };
  });
}

/** Own `__proto__` keys are dropped: they are never data, and copying them
 *  onward would let a later `key in input` check see a smuggled prototype. */
function omit(args: Readonly<Record<string, unknown>>, keys: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(Object.entries(args).filter(([key]) => key !== "__proto__" && !keys.includes(key)));
}
