/** One typed Store per Schema: Core's lowered base statements become a descriptor constant, passed to the shared `createStore`. */
import type { LoweredStatement } from "@aotter/mantle/spec";
import type { StoreSource } from "../domain/model.js";
import { inputType, nativeType } from "../domain/columns.js";
import { entry, exportName } from "../domain/entry.js";
import { recipesOf } from "../domain/recipes.js";
import { ORDER, WRITE } from "../kernel/store.js";

const q = JSON.stringify;
const FROM = " FROM ( SELECT ";
type Step = (s: LoweredStatement, path: string, fields: readonly string[], row?: boolean) => string;

/** @internal */
export function emitStores(stores: readonly StoreSource[], { isSqlite, step, refuse, entries }: { isSqlite: boolean; step: Step; refuse: (path: string, message: string) => void; entries: Record<string, string> }) {
  const names: string[] = [], declarations: string[] = [];
  for (const [index, store] of stores.entries()) {
    const path = `stores/${store.schema}`;
    // The wrapper begins at the first policy subquery; the select list before it must be the same in both modes.
    const split = (s: LoweredStatement) => {
      const at = s.sql.indexOf(FROM);
      if (at < 0 || !s.sql.endsWith(") AS r")) refuse(path, "Core's base statement must be `SELECT ... FROM (<policy>) AS r` with nothing after the wrapper.");
      return { select: s.sql.slice(0, at), from: s.sql.slice(at), binds: recipesOf(s, [], message => refuse(path, message)) };
    };
    const caller = split(store.read.caller), trusted = split(store.read.trusted);
    if (caller.select !== trusted.select) refuse(path, "The caller and trusted base statements select different columns.");
    const writable = store.cols.filter(c => c[3] & WRITE).map(c => c[1]);
    const fields = ["i_id", "i_lock", ...writable.flatMap(c => [`v_${c}`, `s_${c}`])];
    const update = store.update && `{ caller: ${step(store.update.caller, path + "/update", fields, true)}, trusted: ${step(store.update.trusted, path + "/update", fields, true)} }`;
    const type = (c: StoreSource["cols"][number]) => c[0] === "id" ? "string" : `${nativeType(c[2], isSqlite)} | null`;
    const n = `Store${index}`, name = exportName("store", store.schema);
    declarations.push(
      `export type ${n}Row = { ${store.cols.map(c => `readonly ${q(c[0])}: ${type(c)};`).join(" ")} };`,
      `export type ${n}Fields = { ${store.cols.filter(c => c[3] & 1).map(c => `readonly ${q(c[0])}: ${inputType(c[2])};`).join(" ")} };`,
      `export type ${n}Set = { ${store.cols.filter(c => c[3] & WRITE).map(c => `readonly ${q(c[0])}: ${inputType(c[2])} | null;`).join(" ")} };`,
      `export type ${n}Order = ${store.cols.filter(c => c[3] & ORDER).map(c => q(c[0])).join(" | ") || "never"};`,
      `const ${name} = /* @__PURE__ */ createStore<Database, ${n}Row, ${n}Fields, ${n}Set, ${n}Order>(DIALECT, DRIVER, { schema: ${q(store.schema)}, cols: ${q(store.cols)}, select: ${q(caller.select)}, caller: { from: ${q(caller.from)}, binds: ${q(caller.binds)} }, trusted: { from: ${q(trusted.from)}, binds: ${q(trusted.binds)} }${update ? `, update: ${update}` : ""} });`,
      `export { ${name} };`);
    names.push(`[${q(store.schema)}]: ${name}`);
    entries[`stores/${encodeURIComponent(store.schema)}.ts`] = entry("store", store.schema, `${n}Row as Row, ${n}Fields as Fields, ${n}Set as Set, ${n}Order as Order`);
  }
  return { names, declarations };
}
