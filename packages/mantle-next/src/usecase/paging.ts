/** Selected View boundary: Core prints keyset SQL once; bare operations retain native rows. */
import { parseNumeric, NATIVE_NOT_NULL, notNullColumns, type RuntimePlan, type PlanLowered, type SqlNode } from "@aotter/mantle/spec";
import { declaredType } from "../domain/columns.js";
import { recipesOf } from "../domain/recipes.js";

const q = JSON.stringify;
export function emitPaging(plan: RuntimePlan, lowered: PlanLowered, target: string, refuse: (path: string, message: string) => void): Record<string, string> {
  const files: Record<string, string> = {}, base = "@aotter/mantle-next/";
  const sqlite = target === "bun-sqlite" || target === "cloudflare-d1";
  const driver = target === "bun-sqlite" ? "bun-sqlite" : target === "cloudflare-d1" ? "d1" : "postgres";
  for (const [name, view] of Object.entries(plan.views)) {
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
      files[`paged/views/${encodeURIComponent(name)}.ts`] = `import query from "../../views/${encodeURIComponent(name)}.js";\nimport { ContractError } from "${base}contracts";\nexport default async function page(...[db, caller, input, options = {}]: [...Parameters<typeof query>, { limit?: number; cursor?: string }?]) {\n  if (options.cursor !== undefined || options.limit !== undefined && (!Number.isInteger(options.limit) || options.limit < 1)) throw new ContractError("INPUT_VALIDATION_FAILED", "This single-page View needs a positive limit and no cursor.", ${q(path)});\n  return { rows: await query(db, caller, input) };\n}\n`;
      continue;
    }
    if (!valid) {
      refuse(path, "Paged Views need one indexed NOT NULL order column and an id tiebreak on one Schema; add ORDER BY id or the matching index.");
      continue;
    }
    const mode = view.surface === "public" ? "public" : "caller";
    const c = lowered.views[name]?.[mode], trusted = mode === "caller" ? lowered.views[name]?.trusted : undefined;
    if (!c) continue;
    const cap = sel.limitCount?.A_Const?.ival?.ival ?? 500;
    if (sel.limitCount && (!sel.limitCount.A_Const?.ival || !Number.isInteger(cap) || cap < 1)) { refuse(path, "A paged View LIMIT must be a positive integer literal."); continue; }
    const values = new Set<string>();
    const cursorType = declaredType(schema.fields, fields[0]!) ?? (fields[0] === "version" ? "integer" : "text");
    if (cursorType === "date" || cursorType === "timestamptz") values.add(cursorType === "date" ? "date" : "timestamp");
    const key = "cursor[0]";
    const integer = ["integer", "int4", "int8"].includes(cursorType);
    const numeric = parseNumeric(cursorType);
    const bounds = cursorType === "int4" ? ["-2147483648", "2147483647"] : ["-9223372036854775808", "9223372036854775807"];
    const cursorCheck = cursorType === "bool" ? sqlite ? `${key} === 0 || ${key} === 1` : `typeof ${key} === "boolean"`
      : integer ? `Number.isSafeInteger(${key})${cursorType === "int4" ? ` && ${key} as number >= -2147483648 && ${key} as number <= 2147483647` : ""}${sqlite ? "" : ` || typeof ${key} === "string" && /^-?\\d+$/.test(${key}) && BigInt(${key}) >= ${bounds[0]}n && BigInt(${key}) <= ${bounds[1]}n`}`
      : numeric ? sqlite ? `Number.isSafeInteger(${key})` : `typeof ${key} === "string" && /^-?\\d+(?:\\.\\d+)?$/.test(${key}) && Number.isFinite(Number(${key}))`
      : ["real", "float8"].includes(cursorType) ? `typeof ${key} === "number" && Number.isFinite(${key})`
      : `typeof ${key} === "string"`;
    const variants = [c, ...(trusted ? [trusted] : [])].map(v => {
      const pages = Object.values(v.paged);
      const first = pages.find(p => !p.sources.some(s => "cursor" in s)), next = pages.find(p => p.sources.some(s => "cursor" in s));
      if (!first || !next || v.nkeys < 1 || v.nkeys > 2) { refuse(path, "Core could not lower this View's keyset pages."); return ""; }
      const recipes = recipesOf(v, Object.keys(view.input?.properties ?? {}), message => refuse(path, message));
      for (const r of recipes) if (r.k === "now" || r.k === "cutoff") values.add(r.k); else if (r.k === "input" && r.type) values.add(r.type === "date" ? "date" : "timestamp");
      const page = (p: typeof first) => `{ sql: ${q(p.sql)}, extra: ${q(p.sources.map(s => "cursor" in s ? s.cursor : -1))} }`;
      return `{ binds: ${q(recipes)}, first: ${page(first)}, next: ${page(next)} }`;
    });
    const auth = (view.requires?.auth?.all ?? []).map((p, i) => {
      const allowed = typeof p === "string" ? 'caller.kind === "user"' : "ctx.auth.scope" in p ? `caller.kind === "user" && caller.scopes.includes(${q(p["ctx.auth.scope"])})` : `caller.kind === "user" && ${q(p["ctx.staff"])}.includes(caller.role ?? "")`;
      return `  deny(caller, ${allowed}, ${q(path + "/requires/auth/all/" + i)});`;
    });
    files[`paged/views/${encodeURIComponent(name)}.ts`] = `import { ContractError, deny, type Caller${driver === "postgres" ? ", type Postgres as Database" : ""} } from "${base}contracts";
${driver !== "postgres" ? `import type { Handle as Database } from "${base}driver/${driver}";` : ""}
import { read } from "${base}driver/${driver}";
import { binds } from "${base}binds";
${values.size ? `import { ${[...values].sort().join(", ")} } from "${base}dialect/${sqlite ? "sqlite" : "postgres"}";` : ""}
const D = { ${[...values].sort().join(", ")} };
import { decodeCursor, encodeCursor } from "${base}store";
import type { Input, Row } from "../../views/${encodeURIComponent(name)}.js";
const callerPage = ${variants[0]} as const;
${trusted ? `const trustedPage = ${variants[1]} as const;` : ""}
export default async function page(db: Database, caller: Caller, input: Input, options: { limit?: number; cursor?: string } = {}): Promise<{ rows: Row[]; nextCursor?: string }> {
${auth.join("\n")}
  const requested = options.limit ?? Math.min(50, ${cap});
  if (!Number.isInteger(requested) || requested < 1) throw new ContractError("INPUT_VALIDATION_FAILED", "limit must be a positive integer.", ${q(path + "/limit")});
  const limit = Math.min(requested, ${cap}, 500);
  const m = ${trusted ? 'caller.kind === "system" ? trustedPage : ' : ""}callerPage;
  const values = binds(D, m.binds, caller, input);
  const operation = ${q(path)};
  const cursor = options.cursor === undefined ? undefined : decodeCursor(options.cursor, ${q(path + "/cursor")}, operation);
  if (cursor && !(${cursorCheck})) throw new ContractError("INPUT_VALIDATION_FAILED", "Cursor key has the wrong column type.", ${q(path + "/cursor")});
  let cursorValue = cursor?.[0];
${["timestamptz", "date"].includes(cursorType) ? `  if (cursor) try { cursorValue = D.${cursorType === "date" ? "date" : "timestamp"}(cursor[0] as string); } catch { throw new ContractError("INPUT_VALIDATION_FAILED", "Malformed temporal cursor.", ${q(path + "/cursor")}); }` : ""}
  const keys = ${c.nkeys === 1 ? "cursor && [cursor[1]]" : "cursor && [cursorValue, cursor[1]]"};
  const sql = cursor ? m.next : m.first;
  const rows: (Row & Record<string, unknown>)[] = await read(db, sql.sql, [...values, ...sql.extra.map(i => i < 0 ? limit + 1 : keys![i])]);
  const last = rows[limit - 1];
  const nextCursor = rows.length > limit && last ? encodeCursor(last._k0, last._k${c.nkeys - 1}, operation) : undefined;
  if (rows.length > limit) rows.length = limit;
  for (const row of rows) { delete row._k0; ${Array.from({length:c.nkeys-1},(_,i)=>`delete row._k${i+1};`).join(" ")} }
  return { rows, ...(nextCursor === undefined ? {} : { nextCursor }) };
}
`;

  }
  return files;
}
