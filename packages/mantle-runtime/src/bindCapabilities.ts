import type { MediaPurposePolicy } from "@aotter/mantle-spec";
import type { MantleMedia, MantleRuntime } from "./MantleRuntime.js";
import { interactionReadTargets, projectCallableCapabilities } from "./domain/service/CallableCapabilityProjector.js";
import { buildCapabilityCatalog, type CapabilitySurface } from "./domain/service/CapabilityCatalog.js";
import type { RuntimePlan } from "./domain/service/RuntimePlanCompiler.js";
import {
  InvokeCapabilityUseCase,
  type CapabilityUseCases,
  type EntryPreviewPort,
} from "./usecase/capability/InvokeCapabilityUseCase.js";

/** The runtime members a capability surface invokes. */
export type CapabilityRuntime = Pick<
  MantleRuntime,
  | "schemas"
  | "getEntry"
  | "createDraft"
  | "updateDraft"
  | "requestPublish"
  | "unpublish"
  | "archive"
  | "deleteEntry"
  | "executeView"
  | "invokeTrigger"
> & {
  readonly media: Pick<MantleMedia, "createUpload" | "commitUpload"> | null;
};

export interface BindCapabilitiesOptions {
  readonly surface: CapabilitySurface;
  /** Declared `media.purposes`. Media operations exist only when the runtime
   *  has media storage and at least one purpose is declared. */
  readonly mediaPurposes?: readonly MediaPurposePolicy[];
  /** Site preview for staff (ADR-0029 D10); ignored on the public surface. */
  readonly preview?: EntryPreviewPort;
}

/**
 * Bind one surface of a prepared runtime: the sealed-plan capability catalog
 * plus its single invoke entry. Transports (MCP, WebMCP, HTTP) project
 * `invoker.catalog` onto their wire and call `invoker.execute`; they still
 * own caller identity and their surface gate.
 */
export function bindCapabilities(
  runtime: CapabilityRuntime,
  plan: RuntimePlan,
  options: BindCapabilitiesOptions,
): InvokeCapabilityUseCase {
  const schemas = [...runtime.schemas.values()];
  const { useCases: base, mediaPurposes } = capabilityUseCases(runtime, options.mediaPurposes);
  const preview = options.surface === "staff" ? options.preview : undefined;
  const useCases = preview ? { ...base, preview } : base;
  return new InvokeCapabilityUseCase(
    useCases,
    buildCapabilityCatalog(schemas, {
      surface: options.surface,
      callables: projectCallableCapabilities(plan, { surface: options.surface }),
      mediaPurposes,
      readTargets: interactionReadTargets(plan, options.surface),
      ...(preview ? { previewTargets: preview.collections.filter((name) => runtime.schemas.has(name)) } : {}),
    }),
    schemas,
  );
}

/** Adapt runtime members to the use-case bag. Media is bound only when both
 *  storage and declared purposes exist. */
export function capabilityUseCases(
  runtime: CapabilityRuntime,
  purposes: readonly MediaPurposePolicy[] = [],
): { readonly useCases: CapabilityUseCases; readonly mediaPurposes?: readonly MediaPurposePolicy[] } {
  const media = runtime.media && purposes.length > 0
    ? { createUpload: runtime.media.createUpload, commitUpload: runtime.media.commitUpload }
    : undefined;
  return {
    useCases: {
      getEntry: runtime.getEntry,
      createDraft: runtime.createDraft,
      updateDraft: runtime.updateDraft,
      requestPublish: runtime.requestPublish,
      unpublish: runtime.unpublish,
      archive: runtime.archive,
      deleteEntry: runtime.deleteEntry,
      executeView: {
        execute: (request) => runtime.executeView({ ...request, view: request.view.metadata.name }),
      },
      invokeTrigger: { execute: (request) => runtime.invokeTrigger(request) },
      ...(media ? { media } : {}),
    },
    ...(media ? { mediaPurposes: purposes } : {}),
  };
}
