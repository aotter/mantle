/**
 * The Store's policy comes from Core, never from this package: each Schema gets two synthetic programs that run through the
 * ordinary compile, lowering and wire-form passes beside the authored ones, and whose lowered statements become the Store's
 * descriptor. `SELECT r.* FROM <schema> r` is the base read (Core wraps the relation in its scope, TTL and published
 * predicates); `UPDATE ... WHERE id = input.i_id AND version = input.i_lock` is the OCC write. The write names every
 * writable column once, with a presence flag, so ONE statement serves every combination of columns a call sets:
 * `col = CASE WHEN input.s_col THEN input.v_col ELSE col END`.
 */
import type { LoweredStatement, RuntimePlan } from "@aotter/mantle/spec";
import { declaredType } from "../domain/columns.js";
import type { StoreSource } from "../domain/model.js";
import { FILTER, ORDER, WRITE } from "../kernel/store.js";

/** @internal */
export const STORE_PREFIX = "mantle-store-";
type Schema = RuntimePlan["schemas"][string];
type Col = StoreSource["cols"][number];
const API = "cms.mantle.aotter.net/v2";
// Types the typed Store compares and writes as plain bind values. Fixed numerics are scaled integers on SQLite; geo is two columns.
const SCALAR = new Set(["text", "real", "float8", "integer", "int4", "int8", "bool", "timestamptz", "date"]);

/** The columns Core's wrapper exposes, in output order: `ownerid` (the scope column) is never among them. */
function columns(s: Schema): Col[] {
  const system: [string, string][] = [["id", "id"], ["version", "version"], ["created_at", "createdAt"], ["updated_at", "updatedAt"], ["author_id", "authorId"], ...(s.publishing ? [["status", "status"] as [string, string]] : [])];
  const declared = Object.keys(s.fields).filter(f => f !== s.scope && s.fields[f] !== "geo").map((f): [string, string] => [f, s.names?.[f] ?? f]);
  // ORDER BY is allowed where the caller's scoped read can walk an index: its first column, or the one after the scope column.
  const ordered = new Set(["id", ...[...(s.indexes ?? []), ...(s.unique ?? [])].map(i => i[0] === s.scope ? i[1] : i[0]).filter((c): c is string => !!c)]);
  return [...system, ...declared].map(([column, name]): Col => {
    const type = declaredType(s.fields, column) ?? (column === "version" ? "integer" : "text");
    const scalar = SCALAR.has(type);
    const own = column in s.fields;
    return [name, column, type, (scalar ? FILTER : 0) | (own && !s.publishing && (scalar || type === "json") ? WRITE : 0) | (scalar && ordered.has(column) ? ORDER : 0)];
  });
}

/** Synthetic Views and Procedures, as one manifest source, for every Schema; undefined when there is no Schema. */
/** @internal */
export function storeManifests(schemas: RuntimePlan["schemas"]): string | undefined {
  const docs = Object.values(schemas).flatMap(s => {
    const cols = columns(s), alias = (c: Col) => `r.${c[1]} AS "${c[0]}"`;
    const docsOf = [{ apiVersion: API, kind: "View", metadata: { name: `${STORE_PREFIX}read-${s.name}` }, spec: { surface: "internal", sql: `SELECT ${cols.map(alias).join(", ")} FROM ${s.name} r` } }];
    const writable = cols.filter(c => c[3] & WRITE);
    if (writable.length) {
      const properties = Object.fromEntries([["i_id", { type: "string" }], ["i_lock", { type: "integer" }], ...writable.flatMap(c => [[`v_${c[1]}`, { ...(s.schema.properties?.[c[0]] ?? {}), nullable: true }], [`s_${c[1]}`, { type: "boolean" }]])]);
      docsOf.push({
        apiVersion: API, kind: "Procedure", metadata: { name: `${STORE_PREFIX}update-${s.name}` },
        spec: { input: { type: "object", additionalProperties: false, required: Object.keys(properties), properties }, output: { type: "object", required: ["results"], properties: { results: { type: "array" } } },
          handler: { sql: `UPDATE ${s.name} SET ${writable.map(c => `${c[1]} = CASE WHEN input.s_${c[1]} THEN input.v_${c[1]} ELSE ${c[1]} END`).join(", ")} WHERE id = input.i_id AND version = input.i_lock RETURNING ${cols.map(c => c[1] === "id" || c[1] === "version" ? c[1] : `${c[1]} AS "${c[0]}"`).join(", ")}` } },
      } as never);
    }
    return docsOf;
  });
  return docs.length ? docs.map(d => JSON.stringify(d)).join("\n---\n") : undefined;
}

/** What `generate` needs of each Store, read from the lowered synthetic programs. */
/** @internal */
export function storeSources(plan: RuntimePlan, lowered: { views: Record<string, Record<string, LoweredStatement>>; procedures: Record<string, Record<string, LoweredStatement[]>> }): { stores: StoreSource[]; refusals: { code: string; path: string; message: string }[] } {
  const stores: StoreSource[] = [], refusals: { code: string; path: string; message: string }[] = [];
  const refuse = (schema: string, message: string) => refusals.push({ code: "GENERATE_UNSUPPORTED", path: `stores/${schema}`, message });
  for (const s of Object.values(plan.schemas)) {
    const read = lowered.views[`${STORE_PREFIX}read-${s.name}`], write = lowered.procedures[`${STORE_PREFIX}update-${s.name}`];
    if (!read?.caller || !read.trusted) { refuse(s.name, "Core could not lower the Store's base read."); continue; }
    const one = (m: LoweredStatement[] | undefined) => m?.length === 1 && m[0]!.kind === "row" ? m[0] : undefined;
    const update = write && one(write.caller) && one(write.trusted) ? { caller: write.caller![0]!, trusted: write.trusted![0]! } : undefined;
    if (write && !update) refuse(s.name, "Core did not lower the Store's update to one row statement.");
    stores.push({ schema: s.name, cols: columns(s), read: { caller: read.caller, trusted: read.trusted }, ...(update ? { update } : {}) });
  }
  return { stores, refusals };
}
