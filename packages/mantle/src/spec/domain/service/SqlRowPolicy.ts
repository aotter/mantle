/**
 * What a Schema's rows are, as data: who sees a row, and what a write adds to it. Core's policy rewriter renders these terms to
 * its AST, and a runtime that never compiles (a generated Store) renders them to its own SQL, so the rules are spelled once, here.
 */
import { STAFF_ROLES } from "../model/ManifestGrammar.js";
import type { SqlSchemaDef } from "../model/SqlIr.js";

/** `caller` preserves Core visibility; `staff` additionally hides publishing drafts from non-staff callers. */
export type RowMode = "caller" | "public" | "trusted" | "staff";
/** A value an engine binds. Inside a term a `const` is part of the rule (printed inline); in a write it is an input. */
export type RowValue = { readonly k: "uid" | "role" | "now" | "version" } | { readonly k: "cutoff"; readonly seconds: number } | { readonly k: "const"; readonly value: string };
/** `eq`: `column = value`. `ttl`: `column IS NULL OR column > value`. `staff`: published, or the bound role is staff. */
export type RowTerm = readonly [column: string, op: "eq" | "ttl", value: RowValue] | readonly [column: string, op: "staff", value: RowValue, published: string, roles: readonly string[]];
export type RowSchema = Pick<SqlSchemaDef, "scope" | "ttl" | "ttlSeconds" | "publishing">;
export interface RowWrite {
  /** An insert's columns the policy fills, in order. `newId` is a new entry id. */
  readonly fills: readonly (readonly [column: string, value: RowValue | "newId"])[];
  /** What an update (or an insert's ON CONFLICT update) sets beyond the author's columns. `bump` is `column + 1`. */
  readonly sets: readonly (readonly [column: string, value: RowValue | "bump"])[];
  /** The optimistic-concurrency term; it joins `rowPolicy` in the WHERE. */
  readonly lock?: RowTerm;
}

const PUBLISHED = "published";
const NOW: RowValue = { k: "now" };
/** The rows a caller can see: its own (unless trusted), live (TTL) and, for a public caller of a publishing Schema, published. */
export function rowPolicy(s: RowSchema, mode: RowMode): RowTerm[] {
  return [
    ...(mode !== "trusted" && s.scope ? [[s.scope, "eq", { k: "uid" }] as const] : []),
    ...(s.ttl ? [[s.ttl, "ttl", { k: "cutoff", seconds: s.ttlSeconds! }] as const] : []),
    ...(s.publishing && (mode === "public" || mode === "staff") ? [mode === "public" ? ["status", "eq", { k: "const", value: PUBLISHED }] as const : ["status", "staff", { k: "role" }, PUBLISHED, STAFF_ROLES] as const] : []),
  ];
}

/** What a write adds. `status`: the status an update moves the entry to. `idGiven`: the insert names its id. `lock`: the update is checked against a version. */
export function writePolicy(s: RowSchema, kind: "insert" | "update" | "delete", o: { status?: string; idGiven?: boolean; lock?: boolean } = {}): RowWrite {
  const lock = kind !== "insert" && o.lock ? ["version", "eq", { k: "version" }] as const : undefined;
  if (kind === "delete") return { fills: [], sets: [], lock };
  const sets = [["version", "bump"], ["updated_at", NOW], ...(o.status ? [["status", { k: "const", value: o.status }] as const] : [])] as const;
  if (kind === "update") return { fills: [], sets, lock };
  const uid: RowValue = { k: "uid" };
  return {
    // a scoped Schema always gets a generated id: a caller-chosen id would collide with (and reveal) another owner's row
    fills: [...(s.scope ? [[s.scope, uid] as const] : []), ["created_at", NOW], ["updated_at", NOW], ["author_id", uid], ...(o.idGiven && !s.scope ? [] : [["id", "newId"] as const])],
    sets: sets.slice(0, 2),
  };
}
