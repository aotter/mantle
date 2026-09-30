/**
 * Store: the only path to Mantle-owned entry storage (ADR-0032 decision 1, ADR-0034).
 * `select` and `write` keep ADR-0030's JSON shape; the runtime turns it into the same SQL IR
 * as a manifest's SQL, injects scope, TTL, published-only and OCC, then hands it to a StoreExecutor.
 */
import type { SqlNode } from "../spec/domain/index.js";
import type { Caller } from "./caller.js";
import type { InvocationCause } from "./invocation.js";

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
  readonly like?: string;
  readonly in?: readonly StoreScalar[] | StoreSubquery;
  readonly notIn?: readonly StoreScalar[] | StoreSubquery;
  readonly isNull?: boolean;
}

/** `{ column: value }` is equality and sibling keys are AND; `and` / `or` take non-empty arrays, `not` one condition. */
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
  /** One opaque, versioned format bound to `from` and `orderBy` (ADR-0032 decision 1). */
  readonly cursor?: string;
}

/** A flat row: native columns next to Schema fields. */
export type StoreRow = Readonly<Record<string, unknown>>;

export interface StoreSelectResult<R = StoreRow> {
  readonly rows: readonly R[];
  readonly nextCursor?: string;
}

/** Creates one entry through Schema validation, defaults and hooks; one row of VALUES is a row op. */
export interface StoreInsert {
  readonly insert: string;
  readonly values: Readonly<Record<string, unknown>>;
  /** Client-generated id (see `store.id()`); omitted generates one. */
  readonly id?: string;
  /** An insert ignored or merged by `onConflict` is a set op and returns `{ affected }`. */
  readonly onConflict?: "ignore" | { readonly columns: readonly string[]; readonly update: Readonly<Record<string, unknown>> };
}

/** Row op when `where` pins `id` (may carry `lock`), set op otherwise (ADR-0032 decision 2, ADR-0034 decision 4). */
export interface StoreUpdate {
  readonly update: string;
  readonly set: Readonly<Record<string, unknown>>;
  readonly where: StoreWhere;
  /** Caller-observed version; becomes a version predicate plus `expect: 1`. */
  readonly lock?: number;
  /** Fail the whole write unless exactly this many rows were affected. */
  readonly expect?: number;
}

export interface StoreDelete {
  readonly delete: string;
  readonly where: StoreWhere;
  readonly lock?: number;
  readonly expect?: number;
}

export type StoreWriteOp = StoreInsert | StoreUpdate | StoreDelete;

export type StoreWriteResult = { readonly id: string; readonly version: number } | { readonly affected: number };

export interface SweepExpiredRequest {
  readonly collection: string;
  readonly limit?: number;
  readonly cursor?: string;
  /** false counts without deleting. */
  readonly delete?: boolean;
}

export interface SweepExpiredResult {
  readonly scanned: number;
  readonly removed: number;
  readonly nextCursor?: string;
}

/**
 * Host-level Store: no caller scope, TTL visibility still applies. Failures throw `DiagnosticError`:
 * `INPUT_VALIDATION_FAILED`, `CONFLICT` (with `conflict.reason` and an exact `opIndex`; nothing is written),
 * `RESOURCE_UNAVAILABLE`, `OUTCOME_UNKNOWN`.
 */
export interface MantleStore {
  /** Bind to one request's caller; scope follows the caller. `cause` is the invocation being served, so hooks the Store fires chain to it. */
  as(caller: Caller, cause?: InvocationCause): CallerStore;
  select(query: StoreSelect): Promise<StoreSelectResult>;
  /** Apply every operation or none, in order, as one storage transaction. Results follow operation order. */
  write(ops: readonly StoreWriteOp[]): Promise<readonly StoreWriteResult[]>;
  /** Run a named View as REST and MCP would. `input` is the View's declared `input`. */
  view<R = StoreRow>(name: string, options?: { readonly input?: Readonly<Record<string, unknown>>; readonly limit?: number; readonly cursor?: string }): Promise<StoreSelectResult<R>>;
  /** Host-only maintenance; the only path that sees expired rows. */
  sweepExpired(request: SweepExpiredRequest): Promise<SweepExpiredResult>;
  /** A new entry id from the runtime's id generator. */
  id(): string;
}

/** Procedure-facing Store. Guard Procedures and before hooks get one whose `write` fails. */
export type CallerStore = Omit<MantleStore, "as" | "sweepExpired">;

/** One compiled statement: validated IR with policy already injected, and numbered binds `?1`, `?2`. */
export interface StoreStatement {
  readonly ir: SqlNode;
  readonly binds: readonly unknown[];
  /** Checked inside the batch with `changes()`; a mismatch is `CONFLICT` naming this statement. */
  readonly expect?: number;
}

/** What one applied statement did. `rows` are its RETURNING rows, hidden `_mantle_id` / `_mantle_version` included. */
export interface StoreApplied {
  readonly affected: number;
  readonly rows: readonly StoreRow[];
}

/**
 * The storage port. The only implementation is SqliteStoreExecutor over a DatabaseDriver (ADR-0034 decision 6);
 * it implements the whole IR, so there are no capability flags.
 */
export interface StoreExecutor {
  /** Bind limit per statement, read by the one Core validator (100 on D1). */
  readonly maxBindings: number;
  select(statement: StoreStatement): Promise<readonly StoreRow[]>;
  /** All or nothing, in order. A failure throws `DiagnosticError` and applies nothing. */
  apply(batch: readonly StoreStatement[]): Promise<readonly StoreApplied[]>;
}
