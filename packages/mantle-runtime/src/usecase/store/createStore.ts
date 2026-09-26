import { DiagnosticError, runtimeDiagnostic, type SchemaManifest } from "@aotter/mantle-spec";
import type { HandlerContext } from "../../domain/model/HandlerContext.js";
import type { CallerStore, MantleStore, StoreWhere, StoreWriteOp, StoreWriteResult } from "../../domain/model/Store.js";
import type { SweepExpiredRequest, SweepExpiredResult } from "../../domain/port/ExpirySweeper.js";
import type { IdGenerator } from "../../domain/port/IdGenerator.js";
import type { StoreReader } from "../../domain/port/StoreReader.js";
import type { ViewQueryOptions } from "../../domain/port/ViewQueryExecutor.js";
import type { AtomicDraftOperation, AtomicWriteOutcome } from "../content/AtomicEntryWriteUseCase.js";
import type { ExecuteViewResponse } from "../view/ExecuteViewUseCase.js";
import { scopeStoreWhere, validateStoreSelect, validateStoreWhere } from "./validateStoreQuery.js";

export interface StoreDependencies {
  readonly schemasByName: ReadonlyMap<string, SchemaManifest>;
  /** Absent when the storage adapter cannot run Store queries. */
  readonly reader?: StoreReader;
  readonly write: (operations: readonly AtomicDraftOperation[]) => Promise<readonly AtomicWriteOutcome[]>;
  readonly sweepExpired: (request: SweepExpiredRequest) => Promise<SweepExpiredResult>;
  readonly runView: (
    name: string,
    options: Pick<ViewQueryOptions, "params" | "page" | "show">,
    ctx: HandlerContext | undefined,
  ) => Promise<ExecuteViewResponse<unknown>>;
  readonly idgen: IdGenerator;
}

export interface StoreBinding {
  readonly ctx?: HandlerContext;
  /** Authorization guard Procedures get a read-only Store. */
  readonly readOnly?: boolean;
}

/** The Store facade (ADR-0030), bound to one caller context when inside a Procedure. */
export function createStore(deps: StoreDependencies): MantleStore;
export function createStore(deps: StoreDependencies, binding: StoreBinding): CallerStore;
export function createStore(deps: StoreDependencies, binding: StoreBinding = {}): MantleStore | CallerStore {
  const { ctx, readOnly = false } = binding;
  const callerBound = Object.hasOwn(binding, "ctx");
  const refuseWrite = (path: string, message = "Authorization guard Procedures cannot write; the Store they receive is read-only.") => Promise.reject(new DiagnosticError(runtimeDiagnostic({
    code: "INPUT_VALIDATION_FAILED", severity: "error", path,
    message,
  })));
  return {
    select: async (query) => {
      if (!deps.reader) {
        return Promise.reject(new DiagnosticError(runtimeDiagnostic({
          code: "RESOURCE_UNAVAILABLE", severity: "error", path: "store/select",
          expected: "storage adapter with the store capability",
          message: "This storage adapter cannot run Store queries.",
        })));
      }
      return deps.reader.select(validateStoreSelect(query, deps.schemasByName, ctx?.user?.id, callerBound));
    },
    write: async (ops) => {
      if (readOnly) return refuseWrite("store/write");
      if (!Array.isArray(ops)) throw invalid("store.write takes an array of operations.");
      const outcomes = await deps.write(ops.map((op, index) => toOperation(op, index, ctx, callerBound, deps.schemasByName)));
      return outcomes.map((outcome): StoreWriteResult => outcome.row
        ? { id: outcome.row.id, version: outcome.row.version }
        : { deleted: outcome.affected });
    },
    ...(!callerBound ? { sweepExpired: (request: SweepExpiredRequest) => deps.sweepExpired(request) } : {}),
    view: async (name, options = {}) => {
      const response = await deps.runView(name, options, ctx);
      if (!response.ok) throw new DiagnosticError(response.diagnostic);
      return response.result as never;
    },
    id: () => deps.idgen.next(),
  };
}

const OP_KEYS = {
  insert: ["insert", "values", "id"],
  update: ["update", "set", "where", "lock"],
  delete: ["delete", "where", "lock", "expect"],
} as const;

function toOperation(op: StoreWriteOp, index: number, ctx: HandlerContext | undefined, callerBound: boolean, schemas: ReadonlyMap<string, SchemaManifest>): AtomicDraftOperation {
  const at = `store.write[${index}]`;
  if (typeof op !== "object" || op === null || Array.isArray(op)) throw invalid(`${at} must be an object.`);
  const kinds = (["insert", "update", "delete"] as const).filter((kind) => Object.hasOwn(op, kind));
  if (kinds.length !== 1) throw invalid(`${at} needs exactly one of insert, update or delete.`);
  const kind = kinds[0]!;
  const unknownKey = Object.keys(op).find((key) => !(OP_KEYS[kind] as readonly string[]).includes(key));
  if (unknownKey) throw invalid(`${at} has an unknown key '${unknownKey}'.`);
  const record = op as unknown as Record<string, unknown>;
  const collection = record[kind];
  if (typeof collection !== "string" || !collection) throw invalid(`${at}.${kind} must name a Schema.`);
  const schema = schemas.get(collection);
  const scopeField = callerBound ? Object.keys(schema?.spec.scope ?? {})[0] : undefined;
  const callerId = ctx?.user?.id;
  if (scopeField && !callerId) throw invalid(`Schema '${collection}' requires a caller identity.`);
  const scope = scopeField ? { field: scopeField, value: callerId! } : undefined;
  const authorId = ctx?.user?.id ?? null;
  if (kind === "insert") {
    const values = record["values"];
    if (!isRecord(values)) throw invalid(`${at}.values must be an object.`);
    const id = record["id"];
    if (id !== undefined && typeof id !== "string") throw invalid(`${at}.id must be a string.`);
    if (scopeField && values[scopeField] !== undefined && values[scopeField] !== callerId) {
      throw invalid(`${at}.values.${scopeField} conflicts with caller scope.`);
    }
    const data = { ...values, ...(scopeField ? { [scopeField]: callerId } : {}) };
    return { kind: "create", ...(id === undefined ? {} : { id }), request: { collection, data, originalInput: scopeField ? data : values, authorId, ...(ctx ? { ctx } : {}) } };
  }
  const where = record["where"];
  if (!isRecord(where)) throw invalid(`${at}.where must be an object.`);
  const lock = record["lock"];
  const expect = record["expect"];
  const rowId = Object.keys(where).length === 1 && typeof where["id"] === "string" ? where["id"] : undefined;
  if (kind === "update") {
    const set = record["set"];
    if (!isRecord(set)) throw invalid(`${at}.set must be an object.`);
    if (rowId === undefined) throw invalid(`${at}.where must be exactly { id } for an update.`);
    if (typeof lock !== "number") throw invalid(`${at}.lock (the version you read) is required for an update.`);
    if (scopeField && Object.hasOwn(set, scopeField) && set[scopeField] !== callerId) {
      throw invalid(`${at}.set.${scopeField} conflicts with caller scope.`);
    }
    return { kind: "update", request: { collection, id: rowId, expectedVersion: lock, data: { ...set }, originalInput: set, ...(ctx ? { ctx } : {}) }, ...(scope ? { scope } : {}) };
  }
  if (lock !== undefined) {
    if (rowId === undefined) throw invalid(`${at}.lock needs where to be exactly { id }.`);
    if (typeof lock !== "number") throw invalid(`${at}.lock must be a number.`);
    if (expect !== undefined) throw invalid(`${at}.expect applies only to a set-based delete; a locked row delete already affects exactly one row.`);
    return { kind: "delete", request: { collection, id: rowId, expectedVersion: lock, ...(ctx ? { ctx } : {}) }, ...(scope ? { scope } : {}) };
  }
  if (expect !== undefined && typeof expect !== "number") throw invalid(`${at}.expect must be a number.`);
  if (!schema) throw invalid(`Unknown Schema '${collection}'.`);
  validateStoreWhere(where as StoreWhere, schema, schemas);
  const scoped = callerBound ? scopeStoreWhere(where as StoreWhere, schema, schemas, ctx?.user?.id) : structuredClone(where) as StoreWhere;
  return { kind: "deleteWhere", request: { collection, where: scoped!, ...(expect === undefined ? {} : { expect }) } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalid(message: string): DiagnosticError {
  return new DiagnosticError(runtimeDiagnostic({ code: "INPUT_VALIDATION_FAILED", severity: "error", path: "store/write", message }));
}
