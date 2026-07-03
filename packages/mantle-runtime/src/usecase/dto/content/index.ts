import type { ContentState } from "@aotter/mantle-spec";
import type { HandlerContext } from "../../../domain/model/HandlerContext.js";

/**
 * Content-op request DTOs. Each verb takes its own request type;
 * response is `EntryRow` (or `{ removed: boolean }` for delete) which
 * lives in `domain/model/`. Per the clean-arch DTO rule, no loose
 * primitives — every input field is named on the DTO.
 *
 * Mutating verbs carry an optional `ctx: HandlerContext` so the
 * `LifecycleHookingEntryRepository` decorator can fire hooks with the
 * caller's auth + env when invoked from a real dispatcher (HTTP
 * Trigger, MCP, admin endpoint). Test paths and internal writes leave
 * it unset and the decorator falls back to an anonymous ctx.
 */
export interface ContentMutationFields {
  readonly ctx?: HandlerContext;
  /** Pre-projection original input forwarded to lifecycle hooks
   *  (`ctx.event.originalInput` on the hook's procedure call). When
   *  unset, hooks see the row data instead. The builtin Procedure path
   *  populates this with the full procedure input so hooks can read
   *  side-channel fields like CAPTCHA tokens. */
  readonly originalInput?: unknown;
}

export interface CreateDraftRequest extends ContentMutationFields {
  readonly collection: string;
  readonly data: Record<string, unknown>;
  readonly authorId: string | null;
}

export interface UpdateDraftRequest extends ContentMutationFields {
  readonly id: string;
  readonly expectedVersion: number;
  /** Partial data — merged onto the existing row's `data` blob. */
  readonly data: Record<string, unknown>;
}

export interface GetEntryRequest {
  readonly id: string;
  /** When set, asserts the row's collection matches; rejects with
   *  `NOT_FOUND` otherwise. */
  readonly collection?: string;
}

export interface ListEntriesRequest {
  readonly collection: string;
  readonly status?: ContentState;
  readonly limit?: number;
  /** Opaque cursor from a prior `ListEntriesResponse.nextCursor`. */
  readonly cursor?: string;
  /** Free-text filter matched against `id` and the raw data blob. */
  readonly search?: string;
}

export interface ListEntriesResponse<R> {
  readonly rows: readonly R[];
  /** Present when there may be more rows; pass back as `cursor`. */
  readonly nextCursor?: string;
}

export interface RequestPublishRequest extends ContentMutationFields {
  readonly id: string;
}

export interface UnpublishRequest extends ContentMutationFields {
  readonly id: string;
}

export interface ArchiveRequest extends ContentMutationFields {
  readonly id: string;
  /** @deprecated Ignored. `ArchiveUseCase` pins OCC to the version it
   *  reads internally so the transition guard and the chokepoint
   *  check see the same snapshot. Field kept optional for backwards
   *  compat; remove in v0.2. */
  readonly expectedVersion?: number;
}

export interface DeleteEntryRequest extends ContentMutationFields {
  readonly id: string;
}

export interface DeleteEntryResponse {
  readonly removed: boolean;
}
