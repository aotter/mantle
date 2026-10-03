/**
 * The printer (ADR-0034 decision 3): pgsql-deparser, subclassed. The subset is the syntax PostgreSQL and
 * SQLite share, so most nodes print as they are; each override exists because a case fails on local D1
 * without it. Runs in the Worker: AST in, SQL text out, no parser.
 */
import { Deparser } from "pgsql-deparser";
import type { SqlNode } from "../spec/domain/index.js";
import { parenthesized } from "../core/sql/ast.js";

/** A pre-lowered SQLite expression: strings print as they are, nodes print as the deparser would, always in parentheses. */
export interface RawExpr {
  readonly parts: readonly (string | SqlNode)[];
}

export class SqliteDeparser extends Deparser {
  /** PostgreSQL prints $n; SQLite reads $n as a NAMED parameter numbered by first appearance, so binds would shift silently. */
  override ParamRef(n: SqlNode) {
    return `?${n.number}`;
  }
  /** PostgreSQL prints x::type; SQLite has only CAST(x AS type). */
  override TypeCast(n: SqlNode, ctx: any) {
    return `CAST(${this.visit(n.arg as never, ctx)} AS ${n.typeName.names.at(-1).String.sval})`;
  }
  /** PostgreSQL prints E'a\\b' for a string with a backslash; SQLite has no E'' strings. */
  override A_Const(n: SqlNode, ctx: any) {
    return n.sval ? `'${String(n.sval.sval ?? "").replace(/'/g, "''")}'` : super.A_Const(n, ctx);
  }
  /** `x LIKE p ESCAPE e` parses to LIKE with pg_catalog.like_escape(p, e), which SQLite has no function for. */
  override A_Expr(node: SqlNode, ctx: any) {
    const n = parenthesized("A_Expr", node);
    const fc = n.rexpr?.FuncCall;
    // only the parser's own like_escape(p, e); any other function on the right of LIKE is an ordinary pattern expression
    if (n.kind === "AEXPR_LIKE" && fc?.funcname?.at(-1)?.String?.sval === "like_escape" && fc.args?.length === 2) {
      const [pat, esc] = fc.args;
      const not = n.name[0].String.sval === "!~~" ? "NOT " : "";
      return `${this.visit(n.lexpr as never, ctx)} ${not}LIKE ${this.visit(pat as never, ctx)} ESCAPE ${this.visit(esc as never, ctx)}`;
    }
    return super.A_Expr(n, ctx);
  }
  override NullTest(n: SqlNode, ctx: any) { return super.NullTest(parenthesized("NullTest", n) as never, ctx); }
  override BooleanTest(n: SqlNode, ctx: any) { return super.BooleanTest(parenthesized("BooleanTest", n) as never, ctx); }
  override SubLink(n: SqlNode, ctx: any) { return super.SubLink(parenthesized("SubLink", n) as never, ctx); }
  /** Mantle's own lowerings are written as SQLite text with sub-ASTs spliced in (see `raw` in policy.ts). */
  Raw(n: RawExpr, ctx: any) {
    return `(${n.parts.map((p) => (typeof p === "string" ? p : this.visit(p as never, ctx))).join("")})`;
  }
}

export function print(ast: SqlNode): string {
  return new SqliteDeparser([ast] as any, { pretty: false }).deparseQuery();
}
