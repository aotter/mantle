import type { ContentState } from "@aotter/mantle-spec";
import type { EntryRow } from "../model/EntryRow.js";
import type { HandlerContext } from "../model/HandlerContext.js";

/**
 * `EntryRepository` — chokepoint for every entry mutation. Content-op
 * use cases, MCP handlers, and builtin Procedure handlers all route
 * writes through this interface so OCC, status guards, and lifecycle
 * hooks have exactly one place to enforce them.
 *
 * Concrete impls: `DatabaseDriver`-backed
 * (`infrastructure/persistence/DatabaseEntryRepository`) +
 * `LifecycleHookingEntryRepository` decorator that wraps it. Test
 * harness ships an in-memory fake in `test/fakes/`.
 *
 * Renamed from `EntryStore` per the clean-architecture naming
 * convention (`*Repository` for data access).
 */
export interface EntryRepository {
  create(args: CreateEntryArgs): Promise<EntryRow>;
  get(id: string): Promise<EntryRow | null>;
  /** Throws `EntryVersionConflict` on OCC mismatch. */
  update(args: UpdateEntryArgs): Promise<EntryRow>;
  delete(args: DeleteEntryArgs): Promise<{ readonly removed: boolean }>;
  /** Status flip without data update. `expectedStatus`, when set,
   *  atomically asserts pre-flip status to prevent races (e.g. a
   *  concurrent publish while we try to archive). Bumps version.
   *  Throws `EntryStatusConflict` on guard mismatch. */
  transitionStatus(args: TransitionStatusArgs): Promise<EntryRow>;
  /** List entries in a collection, optionally filtered by status.
   *  Pass `cursor` from a previous `ListEntriesResult.nextCursor` to
   *  fetch the next page. Pagination matters because D1 silently
   *  truncates responses past ~10 MB; without it, large collections
   *  return partial pages indistinguishable from "no more rows". */
  list(args: ListEntriesArgs): Promise<ListEntriesResult>;
  /** Find one entry by a top-level JSON data field. Used for runtime
   *  referential checks such as `Schema.spec.translates`. */
  findByDataField(args: FindEntryByDataFieldArgs): Promise<EntryRow | null>;
  /** Find one entry by a composite set of top-level JSON data fields.
   *  Used to enforce `Schema.spec.uniqueIndexes` at the shared
   *  authoring chokepoint. */
  findByDataFields(args: FindEntryByDataFieldsArgs): Promise<EntryRow | null>;
}

/**
 * Hook-related fields shared by every mutating chokepoint args type.
 * The persistence-layer impl ignores these; the
 * `LifecycleHookingEntryRepository` decorator reads them to fire
 * before_/after_ Triggers with the right context. Only synchronous
 * `before_*` handlers receive the original input.
 *
 * `hookContext` defaults to an anonymous `HandlerContext` in the
 * decorator when callers don't supply one (test paths, internal
 * boot-time writes).
 *
 * `collection` is required on every mutation other than `create` so
 * the decorator can short-circuit hook firing on no-hook Schemas
 * without paying an extra `inner.get(id)` round-trip just to learn
 * the row's collection. Callers always know the collection at write
 * time (use cases hold the schema; MCP carries it in the request).
 */
export interface MutationHookFields {
  readonly hookContext?: HandlerContext;
  readonly originalInput?: unknown;
}

export interface CreateEntryArgs extends MutationHookFields {
  readonly id: string;
  readonly collection: string;
  readonly status: ContentState;
  readonly data: Record<string, unknown>;
  readonly authorId: string | null;
  readonly now: number;
}

export interface UpdateEntryArgs extends MutationHookFields {
  readonly id: string;
  readonly collection: string;
  readonly expectedVersion: number;
  readonly data: Record<string, unknown>;
  readonly now: number;
}

export interface DeleteEntryArgs extends MutationHookFields {
  readonly id: string;
  readonly collection: string;
  /** Atomic snapshot guards. Delete cascades must remove children only
   *  when the parent still matches this exact state. */
  readonly expectedStatus: ContentState;
  readonly expectedVersion: number;
}

export interface TransitionStatusArgs extends MutationHookFields {
  readonly id: string;
  readonly collection: string;
  readonly to: ContentState;
  readonly expectedStatus?: ContentState;
  /** OCC guard. Impls must add `AND version = ?` and throw
   *  `EntryVersionConflict` on miss, so a concurrent UpdateDraft
   *  between caller-side validation and the flip cannot publish
   *  stale data. */
  readonly expectedVersion?: number;
  readonly now: number;
}

export interface ListEntriesArgs {
  readonly collection: string;
  readonly status?: ContentState;
  readonly limit?: number;
  /** Opaque continuation token from a prior `ListEntriesResult.nextCursor`.
   *  Caller must round-trip without interpreting; format is impl-defined. */
  readonly cursor?: string;
  /** Fetch the page before `cursor`; default is the page after it. */
  readonly cursorDirection?: "forward" | "backward";
  /** Free-text filter matched against `id` and `searchFields`
   *  (substring, case-insensitive for ASCII per SQLite `LIKE`). */
  readonly search?: string;
  /** Trusted top-level string fields resolved from Schema.searchableFields. */
  readonly searchFields?: readonly string[];
  /** Trusted exact enum filter resolved from the Schema's indexed fields. */
  readonly filter?: { readonly field: string; readonly value: string };
  /** Native fields or Schema-indexed scalar data fields only. */
  readonly sort?: EntrySort;
}

export interface EntrySort {
  readonly field: string;
  readonly direction: "asc" | "desc";
}

export interface ListEntriesResult {
  readonly rows: readonly EntryRow[];
  /** Pass back with `cursorDirection: "backward"`. */
  readonly previousCursor?: string;
  /** Present when there may be more rows beyond this page. Undefined
   *  signals "this is the last page". Pass back as `cursor` to
   *  continue. */
  readonly nextCursor?: string;
}

export interface FindEntryByDataFieldArgs {
  readonly collection: string;
  readonly status?: ContentState;
  readonly field: string;
  readonly value: unknown;
}

export interface FindEntryByDataFieldsArgs {
  readonly collection: string;
  readonly status?: ContentState;
  readonly fields: Readonly<Record<string, unknown>>;
  readonly excludeId?: string;
}
