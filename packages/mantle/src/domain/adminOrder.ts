/** Selected Admin orders mirror the existing UI's indexed, required fields and native controls. */
import {adminIndexColumns,NATIVE_NOT_NULL,notNullColumns,type RuntimePlan} from "../build/compiler.js";
import type { CursorKind } from "../kernel/paging.js";
import { dialect as sqlite } from "../kernel/dialect/sqlite.js";
import { dialect as postgres } from "../kernel/dialect/postgres.js";
import { declaredType } from "./columns.js";
type Schema = RuntimePlan["schemas"][string];
export function adminOrder(schema: Schema): Record<string, readonly [CursorKind, boolean]> {
  const notNull=notNullColumns(schema);
  const fields = adminIndexColumns(schema);
  return Object.fromEntries(["id", "updated_at", ...(schema.publishing ? ["status"] : []), ...fields].flatMap(f => {
    const type = declaredType(schema.fields, f) ?? "text";
    const kind: CursorKind | undefined = type === "text" ? "text" : type === "bool" ? "bool" : type === "int4" ? "int4" : ["integer", "int8"].includes(type) ? "int" : ["real", "float8"].includes(type) ? "float" : type === "date" ? "date" : type === "timestamptz" ? "timestamp" : undefined;
    return kind ? [[f, [kind, !NATIVE_NOT_NULL.has(f)&&!notNull.has(f)] as const]] : [];
  }));
}
/** Deployment-only indexes; no request attempts to converge storage. */
export function adminIndexes(schemas: RuntimePlan["schemas"], isSqlite: boolean): string[] {
  const d = isSqlite ? sqlite : postgres;
  return Object.values(schemas).flatMap(s => ["created_at", "updated_at", ...(s.publishing ? ["status"] : [])].flatMap(field =>
    [[], ...(s.scope ? [[s.scope]] : [])].flatMap(prefix => {
      const columns = [...prefix, field, "id"];
      if ([...(s.indexes ?? []), ...(s.unique ?? [])].some(i => columns.every((c, n) => i[n] === c))) return [];
      return [`CREATE INDEX ${d.ident(`_mantle_admin_${s.name}_${prefix.length ? "scoped_" : ""}${field}`)} ON ${d.ident(s.name)} (${columns.map(d.ident).join(", ")})`];
    })));
}
