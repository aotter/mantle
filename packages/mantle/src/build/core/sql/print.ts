/** Printer rules shared by SQLite and PostgreSQL. */
import { Deparser } from "pgsql-deparser";
import type { SqlNode } from "../../spec/domain/index.js";
import { parenthesized } from "./ast.js";
export interface RawExpr {
  readonly parts: readonly (string | SqlNode)[];
}
export class NativeDeparser extends Deparser {
  override NullTest(n: SqlNode, ctx: any) {
    return super.NullTest(parenthesized("NullTest", n) as never, ctx);
  }
  override BooleanTest(n: SqlNode, ctx: any) {
    return super.BooleanTest(parenthesized("BooleanTest", n) as never, ctx);
  }
  override SubLink(n: SqlNode, ctx: any) {
    return super.SubLink(parenthesized("SubLink", n) as never, ctx);
  }
  /** Lowering templates splice SQL text and sub-ASTs into a parenthesized expression. */
  Raw(n: RawExpr, ctx: any) {
    return `(${n.parts.map(p => (typeof p === "string" ? p : this.visit(p as never, ctx))).join("")})`;
  }
}
