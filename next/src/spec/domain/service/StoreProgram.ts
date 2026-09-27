import {
  STORE_INPUT_REFERENCE_PREFIX,
  type HandlerBinding,
  type ProcedureManifest,
  type ProcedureTarget,
  type StoreProgramOp,
  type StoreWhereSpec,
} from "../model/ManifestGrammar.js";

/**
 * Pure rules over Store write ops, shared by `mantle validate`, the plan
 * compiler and Store itself so they classify the same way (ADR-0032
 * decision 2).
 */

/** The value a top-level `where.id` pins, or `undefined` when it pins none. */
export function pinnedId(where: StoreWhereSpec | undefined): unknown {
  if (!where || !Object.hasOwn(where, "id")) return undefined;
  const value = where["id"];
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const comparison = value as Record<string, unknown>;
    if (Object.hasOwn(comparison, "$literal")) return value;
    return Object.keys(comparison).length === 1 && Object.hasOwn(comparison, "eq") ? comparison["eq"] : undefined;
  }
  return Array.isArray(value) || value === null ? undefined : value;
}

/**
 * A row op affects at most one row: an insert, or an update/delete whose
 * `where` pins `id` at the top level, alone or ANDed with more conditions.
 * Classify the caller's `where`, before any policy rewrite, so an injected
 * scope never turns a row op into a set op.
 */
export function isRowOp(op: StoreProgramOp): boolean {
  return "insert" in op || pinnedId(op.where) !== undefined;
}

export function storeOpSchema(op: StoreProgramOp): string {
  return "insert" in op ? op.insert : "update" in op ? op.update : op.delete;
}

export function storeOpVerb(op: StoreProgramOp): "insert" | "update" | "delete" {
  return "insert" in op ? "insert" : "update" in op ? "update" : "delete";
}

/** Input property named by a `$input.<name>` reference, if the value is one. */
export function inputReference(value: unknown): string | undefined {
  return typeof value === "string" && value.startsWith(STORE_INPUT_REFERENCE_PREFIX)
    ? value.slice(STORE_INPUT_REFERENCE_PREFIX.length)
    : undefined;
}

export function isStoreProgram(handler: HandlerBinding): handler is { readonly store: readonly StoreProgramOp[] } {
  return "store" in handler;
}

/**
 * The entity a Procedure mutates. Explicit `spec.target` wins; an inline
 * program with exactly one update/delete whose `where` pins `id` to an
 * input property infers it, with `lock: $input.<v>` as the version.
 */
export function procedureTarget(procedure: ProcedureManifest): ProcedureTarget | undefined {
  if (procedure.spec.target) return procedure.spec.target;
  const handler = procedure.spec.handler;
  if (!isStoreProgram(handler)) return undefined;
  const pinned = handler.store.flatMap((op) => {
    if ("insert" in op) return [];
    const id = inputReference(pinnedId(op.where));
    return id ? [{ op, id }] : [];
  });
  if (pinned.length !== 1) return undefined;
  const { op, id } = pinned[0]!;
  const version = "insert" in op ? undefined : inputReference(op.lock);
  return { schema: storeOpSchema(op), id, ...(version ? { version } : {}) };
}
