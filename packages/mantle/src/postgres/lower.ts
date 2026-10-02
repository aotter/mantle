// The PostgreSQL dialect's lowering (ADR-0035 decision 3): what Core's policy rewriter hands a dialect to spell. Most of Mantle
// SQL is PostgreSQL already, so this is short: casts and binds typed, the SQLite vocabulary of the portable subset spelled in
// PostgreSQL, and the site time zone made explicit. AST in, AST out, no parser.
import { SqlRefusal as Refused, type SqlNode as N } from "../spec/domain/index.js";
import { S, num } from "../core/sql/ast.js";
import type { LoweringScope, PolicyLowering } from "../core/sql/policy.js";
import { encodeDate, encodeNumeric, encodeTimestamptz, decodeDate, decodeNumeric, decodeTimestamptz } from "../d1/codec.js";
import { bindBox } from "../d1/lower.js";
import { parseNumeric } from "../spec/domain/index.js";
import { pgType } from "./codec.js";
import type { RawExpr } from "./print.js";

const fn = (f: string, args: N[], extra: Record<string, unknown> = {}): N => ({ FuncCall: { funcname: [S(f)], args, funcformat: "COERCE_EXPLICIT_CALL", ...extra } });
const str = (s: string): N => ({ A_Const: { sval: { sval: s } } });
/** `CAST(x AS <Mantle type>)` in PostgreSQL's spelling of the type. */
export function cast(x: N, type: string): N {
  const t = pgType(type);
  const m = /^numeric\((\d+), (\d+)\)$/.exec(t);
  return { TypeCast: { arg: x, typeName: m ? { names: [S("numeric")], typmods: [num(Number(m[1])), num(Number(m[2]))], typemod: -1 } : { names: [S(t)], typemod: -1 } } };
}
const coalesce = (...args: N[]): N => ({ CoalesceExpr: { args } });
const by = (node: N): N => ({ SortBy: { node: structuredClone(node), sortby_dir: "SORTBY_DEFAULT", sortby_nulls: "SORTBY_NULLS_DEFAULT" } });
/** `'[]'::json`: json, not jsonb, so it matches json_agg's type. */
const json = (text: string): N => ({ TypeCast: { arg: str(text), typeName: { names: [S("json")], typemod: -1 } } });

type Arg = { input: string; type: string } | { const: number };
const argOf = (n: N, scope: LoweringScope): Arg => {
  const k = n.ColumnRef?.fields?.length === 2 ? n.ColumnRef.fields[1].String.sval : undefined;
  if (k) return { input: k, type: scope.inputs[k]! };
  return { const: Number(n.A_Const?.ival?.ival ?? n.A_Const?.fval?.fval) };
};
/** Great-circle meters between the row's point and (__lat, __lng): the haversine D1 computes, in PostgreSQL's functions. */
const HAV = (lat1: string, lng1: string) =>
  `(2 * 6371008.8 * asin(least(1.0, sqrt(sin(radians(__lat - ${lat1}) / 2) * sin(radians(__lat - ${lat1}) / 2) + cos(radians(${lat1})) * cos(radians(__lat)) * sin(radians(__lng - ${lng1}) / 2) * sin(radians(__lng - ${lng1}) / 2)))))`;

/** PostgreSQL text with sub-ASTs spliced in for `__name`, printed in parentheses (the same device as D1's lowering). */
const TOKEN = /"(?:[^"]|"")*"|'(?:[^']|'')*'|__\w+/g;
function sql(text: string, subst: Record<string, N> = {}): N {
  const parts: (string | N)[] = [];
  let last = 0;
  for (const m of text.matchAll(TOKEN)) {
    if (!m[0].startsWith("__")) continue;
    const node = subst[m[0]];
    if (!node) throw new Error(`lowering template names ${m[0]} but was not given it`);
    if (m.index > last) parts.push(text.slice(last, m.index));
    parts.push("(", structuredClone(node), ")");
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return { Raw: { parts } satisfies RawExpr };
}
const q = (id: string) => `"${id.replace(/"/g, '""')}"`;
const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;
const strConst = (n: N | undefined) => n?.A_Const?.sval?.sval as string | undefined;

export function pgLowering(timeZone: string): PolicyLowering {
  const zone = str(timeZone);
  return {
    input: (param, type) => cast(param, type),
    system: (param, type) => cast(param, type),
    func(f, n, scope: LoweringScope) {
      const args: N[] = n.args ?? [];
      switch (f) {
        // in the site time zone, as D1 computes them
        case "date_trunc": return fn("date_trunc", [args[0]!, scope.tx(args[1]), zone]);
        case "extract": return sql(`CAST(extract(${strConst(args[0])} FROM __ts AT TIME ZONE ${lit(timeZone)}) AS int8)`, { __ts: scope.tx(args[1]) });
        // SQLite's columns (key, value, type, id), so the portable subset's json_each reads the same: see `_mantle_json_each`
        case "json_each": return fn("_mantle_json_each", [cast(scope.tx(args[0]), "json")]);
        // PostgreSQL leaves an aggregate's input order open; ordering by the value (an object by its key) keeps it deterministic.
        // ponytail: D1 aggregates in scan order, so the two engines may order an array differently; neither order is promised
        // json has no ordering of its own, so the order is jsonb's; a DISTINCT aggregate may order only by its argument
        case "json_group_array": { const x = scope.tx(args[0]); return coalesce(fn("json_agg", [x], n.agg_distinct ? { agg_order: [by(x)], agg_distinct: true } : { agg_order: [by(fn("to_jsonb", [x]))] }), json("[]")); }
        case "json_group_object": { const k = scope.tx(args[0]); return coalesce(fn("json_object_agg", [k, scope.tx(args[1])], { agg_order: [by(k)] }), json("{}")); }
        case "json_array_length": return fn("jsonb_array_length", [cast(scope.tx(args[0]), "json")]);
        case "instr": return fn("strpos", [scope.tx(args[0]), scope.tx(args[1])]);
        // PostgreSQL rounds to a scale only as numeric
        case "round": return args.length === 2 ? fn("round", [{ TypeCast: { arg: scope.tx(args[0]), typeName: { names: [S("numeric")], typemod: -1 } } }, scope.tx(args[1])]) : undefined;
        case "mantle.search": {
          const alias = args[0]!.ColumnRef.fields[0].String.sval;
          const { schema, def } = scope.alias(alias);
          if (!def.search?.length) throw new Refused("SQL_FUNCTION", `${schema} declares no search fields`);
          scope.seen("search");
          // ponytail: ILIKE over the declared fields, a scan; a pg_trgm GIN index is the upgrade when a search shows in latency
          const pattern = `'%' || replace(replace(replace(__q, '!', '!!'), '%', '!%'), '_', '!_') || '%'`;
          return sql(def.search.map((fld) => `${q(alias)}.${q(fld)} ILIKE ${pattern} ESCAPE '!'`).join(" OR "), { __q: scope.tx(args[1]) });
        }
        case "mantle.search_rank": {
          const alias = args[0]!.ColumnRef.fields[0].String.sval;
          const { schema, def, searchQuery } = scope.alias(alias);
          if (!def.search?.length) throw new Refused("SQL_FUNCTION", `${schema} declares no search fields`);
          if (!searchQuery) throw new Refused("SQL_FUNCTION", `mantle.search_rank(${alias}) needs a mantle.search(${alias}, ...) in the same query`);
          // ponytail: lower is better, as bm25 is on D1: minus the query's occurrences across the fields. A pg_trgm or tsvector rank is the upgrade
          const count = (fld: string) => `coalesce((length(lower(${q(alias)}.${q(fld)})) - length(replace(lower(${q(alias)}.${q(fld)}), lower(__q), ''))) / greatest(length(__q), 1), 0)`;
          return sql(`-(${def.search.map(count).join(" + ")})`, { __q: scope.tx(searchQuery) });
        }
        case "mantle.near": case "mantle.distance": {
          const [ref, latN, lngN] = args;
          const alias = ref!.ColumnRef.fields[0].String.sval, fld = ref!.ColumnRef.fields[1].String.sval;
          const { schema, def } = scope.alias(alias);
          if (def.fields[fld] !== "geo") throw new Refused("SQL_FUNCTION", `${schema}.${fld} is not a geo field`);
          const la = `${q(alias)}.${q(`${fld}_lat`)}`, ln = `${q(alias)}.${q(`${fld}_lng`)}`;
          const sub = { __lat: scope.tx(latN), __lng: scope.tx(lngN) };
          if (f === "mantle.distance") return sql(HAV(la, ln), sub);
          scope.seen("near");
          // ponytail: the box D1 reads from its R*Tree, here a plain range over the two columns; a GiST index is the upgrade
          const meters = Number(args[3]!.A_Const.ival?.ival ?? args[3]!.A_Const.fval?.fval);
          const b = (box: string) => scope.param({ k: "dialect", box, lat: argOf(latN!, scope), lng: argOf(lngN!, scope), meters });
          return sql(`${la} BETWEEN __b0 AND __b1 AND ${ln} BETWEEN __b2 AND __b3 AND ${HAV(la, ln)} <= ${meters}`,
            { ...sub, __b0: b("minLat"), __b1: b("maxLat"), __b2: b("minLng"), __b3: b("maxLng") });
        }
        case "typeof": case "hex":
        case "json_extract": case "json_set": case "json_insert": case "json_remove":
          throw new Refused("SQL_FUNCTION", `${f} is not supported by the PostgreSQL dialect`);
      }
      return undefined;
    },
    call: (out) => ({ FuncCall: out }),
    cast(n, scope) {
      const t = n.typeName.names.at(-1).String.sval as string;
      const a = n.arg?.A_Const;
      const text = a?.sval?.sval ?? a?.fval?.fval ?? (a?.ival?.ival !== undefined ? String(a.ival.ival) : undefined);
      // a literal is checked as D1 checks it, so both dialects refuse the same text, and sent in one spelling
      if (t === "timestamptz" && text !== undefined) return cast(str(decodeTimestamptz(encodeTimestamptz(text))), "timestamptz");
      if (t === "date" && text !== undefined) return cast(str(decodeDate(encodeDate(text))), "date");
      if (t === "numeric" && n.typeName.typmods?.length === 2) {
        const [p, s] = n.typeName.typmods.map((m: N) => m.A_Const.ival.ival);
        parseNumeric(`numeric(${p}, ${s})`);
        if (text !== undefined) return cast(str(decodeNumeric(encodeNumeric(text, p, s), s)), `numeric(${p},${s})`);
      }
      // a bigint has no cast to bool in PostgreSQL; `_mantle_bool` gives PostgreSQL's int4, text and numeric rules for every type
      if (t === "bool") return fn("_mantle_bool", [scope.tx(n.arg)]);
      return { TypeCast: { ...n, arg: scope.tx(n.arg) } };
    },
    sublink: (out) => ({ SubLink: out }),
    // 32 lower-case hex digits, the shape D1's ids have
    newId: () => fn("replace", [{ TypeCast: { arg: fn("gen_random_uuid", []), typeName: { names: [S("text")], typemod: -1 } } }, str("-"), str("")]),
    columns: () => [],
  };
}
