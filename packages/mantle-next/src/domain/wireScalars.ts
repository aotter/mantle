import type { RuntimePlan, SqlNode } from "@aotter/mantle/spec";

/** A View output's declared Mantle type, when the output is a Schema column as it is. Computed outputs have none. */
export function outputType(plan: RuntimePlan, view: string, key: string): string | undefined {
  const columns = plan.views[view]?.columns;
  const field = columns && Object.hasOwn(columns, key) ? columns[key] : undefined;
  const schema = field && plan.schemas[field.schema];
  return schema && (schema.fields[field!.field] ?? (["created_at", "updated_at"].includes(field!.field) ? "timestamptz" : undefined));
}

const raw = (...parts: (string | SqlNode)[]): SqlNode => ({ Raw: { parts } });

/** A declared timestamp or date in its wire form, formatted by the database: an ISO string in UTC with six fractional digits, or `YYYY-MM-DD`. */
function wire(type: string | undefined, sqlite: boolean, v: SqlNode): SqlNode | undefined {
  if (type === "timestamptz") return sqlite
    // floor, not SQLite's truncating `/` and `%`: a time before 1970 is a negative number of microseconds
    ? raw("strftime('%Y-%m-%dT%H:%M:%S', ((", v, ") - ((", v, ") % 1000000 + 1000000) % 1000000) / 1000000, 'unixepoch') || '.' || substr('00000' || (((", v, ") % 1000000 + 1000000) % 1000000), -6) || 'Z'")
    : raw("to_char((", v, ") AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"')");
  if (type === "date") return sqlite ? raw("date((", v, ") * 86400, 'unixepoch')") : raw("to_char(", v, ", 'YYYY-MM-DD')");
  return undefined;
}

/**
 * Wraps the declared timestamp and date outputs of a View's top-level SELECT (each branch of a set operation), keeping
 * their names. An ORDER BY that resolves to the output column still sorts correctly: these strings sort as their values.
 * Returns a refusal when the outputs cannot be matched to SELECT items by position.
 */
export function wireScalars(ast: SqlNode, keys: readonly string[], types: readonly (string | undefined)[], sqlite: boolean): SqlNode | string {
  if (!types.some(type => type === "timestamptz" || type === "date") || !ast.SelectStmt) return ast;
  const select = (s: SqlNode): SqlNode | string => {
    if (s.op && s.op !== "SETOP_NONE") {
      const larg = select(s.larg), rarg = select(s.rarg);
      return typeof larg === "string" ? larg : typeof rarg === "string" ? rarg : { ...s, larg, rarg };
    }
    if (s.targetList?.length !== keys.length || s.targetList.some((t: SqlNode) => !t.ResTarget || t.ResTarget.val?.ColumnRef?.fields?.at(-1)?.A_Star)) return "Declared timestamp and date outputs need one SELECT item per output.";
    return { ...s, targetList: s.targetList.map((t: SqlNode, i: number) => {
      const val = wire(types[i], sqlite, t.ResTarget.val);
      return val ? { ResTarget: { ...t.ResTarget, name: keys[i], val } } : t;
    }) };
  };
  const out = select(ast.SelectStmt);
  return typeof out === "string" ? out : { ...ast, SelectStmt: out };
}

/** The same wire form for a write's RETURNING list (Core has already expanded `*`): a column of the written table is wrapped by its declared type. */
export function wireReturning(ast: SqlNode, schemas: RuntimePlan["schemas"], sqlite: boolean): SqlNode {
  const [kind, stmt] = Object.entries(ast)[0] ?? [];
  const list = stmt?.returningClause?.exprs;
  if (!list?.length || !["InsertStmt", "UpdateStmt", "DeleteStmt"].includes(kind!)) return ast;
  const schema = schemas[stmt.relation?.relname];
  if (!schema) return ast;
  const typeOf = (col: string) => schema.fields[col] ?? (["created_at", "updated_at"].includes(col) ? "timestamptz" : undefined);
  let changed = false;
  const exprs = [];
  for (const t of list) {
    const fields = t.ResTarget?.val?.ColumnRef?.fields;
    const col = fields?.at(-1)?.String?.sval;
    const val = col === undefined ? undefined : wire(typeOf(col), sqlite, t.ResTarget.val);
    if (val) changed = true;
    exprs.push(val ? { ResTarget: { ...t.ResTarget, name: t.ResTarget.name ?? col, val } } : t);
  }
  return changed ? { [kind!]: { ...stmt, returningClause: { ...stmt.returningClause, exprs } } } : ast;
}
