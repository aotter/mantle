import type { ViewQueryOptions, ViewQueryResult } from "../port/ViewQueryExecutor.js";

/**
 * Store — Mantle's single persistence object (ADR-0030, #1151).
 *
 * Queries are a closed, relational JSON AST that storage adapters compile to
 * their native dialect. Values are always bound, never interpolated.
 */
export type StoreScalar = string | number | boolean | null;

/** `{ select, from, where }`, allowed only as the right side of `in` / `notIn`. */
export interface StoreSubquery {
  readonly select: string;
  readonly from: string;
  readonly where?: StoreWhere;
}

export interface StoreComparison {
  readonly eq?: StoreScalar;
  readonly ne?: StoreScalar;
  readonly gt?: string | number;
  readonly gte?: string | number;
  readonly lt?: string | number;
  readonly lte?: string | number;
  readonly in?: readonly StoreScalar[] | StoreSubquery;
  readonly notIn?: readonly StoreScalar[] | StoreSubquery;
  readonly isNull?: boolean;
}

/**
 * `{ column: value }` is equality and sibling keys are AND. `and` / `or` take
 * non-empty arrays; `not` takes one condition. Columns are Schema fields with
 * a scalar type or the native `id`, `status`, `version`, `createdAt`,
 * `updatedAt` and `authorId`.
 */
export interface StoreWhere {
  readonly and?: readonly StoreWhere[];
  readonly or?: readonly StoreWhere[];
  readonly not?: StoreWhere;
  readonly [column: string]: StoreScalar | StoreComparison | StoreWhere | readonly StoreWhere[] | undefined;
}

export interface StoreSelect {
  readonly from: string;
  /** Projection; omitted returns native columns plus every Schema field. */
  readonly columns?: readonly string[];
  readonly where?: StoreWhere;
  /** At most one column; `id` breaks ties. Defaults to `{ updatedAt: "desc" }`. */
  readonly orderBy?: Readonly<Record<string, "asc" | "desc">>;
  /** Default 50, maximum 500. */
  readonly limit?: number;
  /** Opaque cursor from a previous result with the same `from` and `orderBy`. */
  readonly cursor?: string;
}

/** A flat row: native columns next to Schema fields (the parser forbids name clashes). */
export type StoreRow = Readonly<Record<string, unknown>>;

export interface StoreSelectResult {
  readonly rows: readonly StoreRow[];
  readonly nextCursor?: string;
}

/**
 * Bound to one runtime (and, inside a Procedure, to the caller's context).
 * Failures throw `DiagnosticError`: `INPUT_VALIDATION_FAILED` for an invalid
 * query and `RESOURCE_UNAVAILABLE` when the storage adapter cannot run it.
 */
export interface MantleStore {
  select(query: StoreSelect): Promise<StoreSelectResult>;
  /** Run a named View with the caller's context, as REST and MCP would. */
  view<R = StoreRow>(name: string, options?: Pick<ViewQueryOptions, "params" | "page" | "show">): Promise<ViewQueryResult<R>>;
  /** A new entry id from the runtime's id generator. */
  id(): string;
}
