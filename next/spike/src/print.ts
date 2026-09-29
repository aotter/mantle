// The printer (ADR-0034 decision 3): pgsql-deparser, subclassed. The subset is syntax PostgreSQL and
// SQLite share, so most nodes print as they are; every method below exists because a case in
// cases/deparser.ts fails on local D1 without it. `OVERRIDES` is read off the prototype, so the count
// in the report cannot drift from the code.
import { Deparser } from 'pgsql-deparser';
import type { N } from './types.ts';

export class VanillaDeparser extends Deparser {}

export class SqliteDeparser extends Deparser {
  /** PostgreSQL prints $n; SQLite's numbered parameter is ?n */
  ParamRef(n: N) {
    return `?${n.number}`;
  }
  /** PostgreSQL prints x::type; SQLite has only CAST(x AS type) */
  TypeCast(n: N, ctx: any) {
    return `CAST(${this.visit(n.arg, ctx)} AS ${n.typeName.names.at(-1).String.sval})`;
  }
  /** PostgreSQL prints E'a\\b' for a string with a backslash; SQLite reads that as a blob-ish syntax error */
  A_Const(n: N, ctx: any) {
    return n.sval ? `'${String(n.sval.sval ?? '').replace(/'/g, "''")}'` : super.A_Const(n, ctx);
  }
  /** `x LIKE p ESCAPE e` parses to LIKE with pg_catalog.like_escape(p, e), which SQLite has no function for */
  A_Expr(n: N, ctx: any) {
    if (n.kind === 'AEXPR_LIKE' && n.rexpr?.FuncCall) {
      const [pat, esc] = n.rexpr.FuncCall.args;
      const not = n.name[0].String.sval === '!~~' ? 'NOT ' : '';
      return `${this.visit(n.lexpr, ctx)} ${not}LIKE ${this.visit(pat, ctx)} ESCAPE ${this.visit(esc, ctx)}`;
    }
    return super.A_Expr(n, ctx);
  }
}
// Further overrides, if `cases/deparser.ts` finds any, are added above with the case that needs them.

export const OVERRIDE_WHY: Record<string, string> = {
  ParamRef: 'PostgreSQL prints $n; SQLite reads $n as a NAMED parameter numbered by first appearance, so binds silently shift when ?3 appears before ?2',
  TypeCast: 'PostgreSQL prints x::type; SQLite has only CAST(x AS type)',
  A_Const: "PostgreSQL prints E'..' for a string containing a backslash; SQLite has no E'' strings",
  A_Expr: "x LIKE p ESCAPE e parses to LIKE with pg_catalog.like_escape(p, e); SQLite has no such function, its syntax is the ESCAPE clause",
};
export const OVERRIDES = Object.getOwnPropertyNames(SqliteDeparser.prototype).filter((k) => k !== 'constructor');

export function print(ast: N, Printer: typeof Deparser = SqliteDeparser): string {
  return new Printer([ast] as any, { pretty: false }).deparseQuery();
}
