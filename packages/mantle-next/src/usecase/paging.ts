/** Selected View boundary: Core prints keyset SQL once; bare operations retain native rows. */
import { parseNumeric, NATIVE_NOT_NULL, notNullColumns, type RuntimePlan, type PlanLowered, type SqlNode } from "@aotter/mantle/spec";
import {authLines} from "../domain/input.js";
import { driverFor, databaseImport, isSqlite, q } from "../domain/entry.js";
import { declaredType } from "../domain/columns.js";
import { recipesOf } from "../domain/recipes.js";

export function emitPaging(plan: RuntimePlan, lowered: PlanLowered, target: string, refuse: (path: string, message: string) => void, adminPages?: import("../domain/model.js").GenerateInput["adminPages"]): Record<string, string> {
  const files: Record<string, string> = {}, base = "@aotter/mantle-next/";
  const sqlite = isSqlite(target);
  const driver = driverFor(target);
  for (const [name, view] of Object.entries(plan.views)) {
    if (adminPages && !adminPages[name]) continue;
    let adminPage = 0;
    if (view.surface === "internal") continue;
    const path = `views/${name}`, sel = view.stmts[0]?.SelectStmt;
    const relation = sel?.fromClause?.length === 1 && sel.fromClause[0];
    const sub = relation?.RangeSubselect;
    const inner = sub?.subquery?.SelectStmt;
    const table = relation?.RangeVar ?? (inner?.fromClause?.length === 1 && !inner.groupClause && !inner.distinctClause && inner.fromClause[0].RangeVar ? { ...inner.fromClause[0].RangeVar, alias: sub.alias } : undefined);
    const lineage = [...new Set(Object.values(view.columns ?? {}).map(c => c.schema))];
    const schema = table && (plan.schemas[table.relname] ?? (table.mantle === "cte" && lineage.length === 1 ? plan.schemas[lineage[0]!] : undefined));
    const sorts: SqlNode[] = sel?.sortClause ?? [];
    const fields = sorts.map(s => {
      const f = s.SortBy.node.ColumnRef?.fields;
      const col = f?.at(-1)?.String?.sval;
      if (f?.length === 1 && view.columns?.[col]) return view.columns[col]!.field;
      return f?.length <= 2 && (f.length === 1 || f[0].String?.sval === (table?.alias?.aliasname ?? table?.relname)) ? col : undefined;
    });
    const indexed = new Set(schema ? [...(schema.indexes ?? []), ...(schema.unique ?? [])].map(i => i[0] === schema.scope ? i[1] : i[0]) : []);
    const nonNull = schema && notNullColumns(schema);
    const valid = schema && !sel.groupClause && !sel.distinctClause && fields.length >= 1 && fields.length <= 2 && fields.every(f => f && (NATIVE_NOT_NULL.has(f) || nonNull!.has(f)) && (f === "id" || indexed.has(f))) && (fields.length === 1 || fields[1] === "id") && (fields.length === 1 || (sorts[0]!.SortBy.sortby_dir === "SORTBY_DESC") === (sorts[1]!.SortBy.sortby_dir === "SORTBY_DESC"));
    if (!sorts.length && (!sel?.fromClause?.length || !sel.groupClause && sel.targetList?.some((t: SqlNode) => ["count", "sum", "min", "max", "avg"].includes(t.ResTarget.val.FuncCall?.funcname?.at(-1)?.String?.sval)))) {
      files[`paged/views/${encodeURIComponent(name)}.ts`] = `import query from "../../views/${encodeURIComponent(name)}.js";\nimport { single } from "${base}paging";\nexport default (...[db, caller, input, options]: [...Parameters<typeof query>, { limit?: number; cursor?: string }?]) => single(() => query(db, caller, input), ${q(path)}, options);\n`;
      continue;
    }
    if (!valid) {
      refuse(path, "Paged Views need one indexed NOT NULL order column and an id tiebreak on one Schema; add ORDER BY id or the matching index.");
      continue;
    }
    const mode = view.surface === "public" ? "public" : "caller";
    const c = lowered.views[name]?.[mode], trusted = mode === "caller" && !adminPages ? lowered.views[name]?.trusted : undefined;
    if (!c) continue;
    const cap = sel.limitCount?.A_Const?.ival?.ival ?? 500;
    if (sel.limitCount && (!sel.limitCount.A_Const?.ival || !Number.isInteger(cap) || cap < 1)) { refuse(path, "A paged View LIMIT must be a positive integer literal."); continue; }
    const values = new Set<string>();
    const cursorType = declaredType(schema.fields, fields[0]!) ?? (fields[0] === "version" ? "integer" : "text");
    if (cursorType === "date" || cursorType === "timestamptz") values.add(cursorType === "date" ? "date" : "timestamp");
    const kind = cursorType === "bool" ? "bool" : cursorType === "int4" ? "int4" : ["integer", "int8"].includes(cursorType) ? "int" : parseNumeric(cursorType) ? "numeric" : ["real", "float8"].includes(cursorType) ? "float" : cursorType === "date" ? "date" : cursorType === "timestamptz" ? "timestamp" : "text";
    const variants = [c, ...(trusted ? [trusted] : [])].map(v => {
      const pages = Object.values(v.paged);
      const first = pages.find(p => !p.sources.some(s => "cursor" in s)), next = pages.find(p => p.sources.some(s => "cursor" in s));
      if (!first || !next || v.nkeys < 1 || v.nkeys > 2) { refuse(path, "Core could not lower this View's keyset pages."); return ""; }
      const recipes = recipesOf(v, Object.keys(view.input?.properties ?? {}), message => refuse(path, message), values);
      const page = (p: typeof first) => { const matched = adminPages?.[name]?.[adminPage++]; return `{ sql: ${q(matched?.sql ?? p.sql)}, extra: ${q(p.sources.map(s => "cursor" in s ? s.cursor : -1))} }`; };
      return `{ binds: ${q(recipes)}, first: ${page(first)}, next: ${page(next)} }`;
    });
    const auth = authLines(view.requires,path);
    const spec = [`path: ${q(path)}`, `cap: ${cap}`, `sqlite: ${sqlite}`, `cursor: ${q(kind)}`, `keys: ${c.nkeys}`, `values: {${values.size ? ` ${[...values].sort().join(", ")} ` : ""}}`, "read", `caller: ${variants[0]}`, ...(trusted ? [`trusted: ${variants[1]}`] : []), ...(auth.length ? [`auth: (caller: Caller) => {\n${auth.join("\n")}\n  }`] : [])];
    files[`paged/views/${encodeURIComponent(name)}.ts`] = `import { page, type Paged } from "${base}paging";
import { ${auth.length ? "deny, " : ""}type Caller } from "${base}contracts";
${databaseImport(target)}
import { read } from "${base}driver/${driver}";
${values.size ? `import { ${[...values].sort().join(", ")} } from "${base}dialect/${sqlite ? "sqlite" : "postgres"}";\n` : ""}import type { Input, Row } from "../../views/${encodeURIComponent(name)}.js";
const spec: Paged<Database> = {
  ${spec.join(",\n  ")},
};
export default (db: Database, caller: Caller, input: Input, options?: { limit?: number; cursor?: string; match?: Readonly<Record<string,unknown>> }) => page<Database, Row>(${adminPages ? `{...spec, read: (db, sql, values) => read(db, sql, [...values, ...${q(adminPages[name]?.[0]?.matches??[])}.map(key => options?.match?.[key] ?? null)])}` : "spec"}, db, caller, input, options);
`;
  }
  return files;
}
