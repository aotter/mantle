/**
 * Core's bind recipes (`BindSpec` in the policy rewriter), evaluated for one call. Generated Views, generated
 * Procedures and the Store all bind through this one function. Input recipes carry the authored field name; `version` reads the Store's lock from `input`.
 */
import { deny, isAdmin, type Caller } from "./contracts.js";
import type { Dialect } from "./dialect/common.js";

export type Recipe =
  | { readonly k: "user"; readonly field: string; readonly type: "string" | "number"; readonly multiple: boolean; readonly scope?: true }
  | { readonly k: "uid" | "admin" | "now" | "version" }
  | { readonly k: "cutoff"; readonly seconds: number }
  | { readonly k: "const"; readonly value: unknown }
  | { readonly k: "input"; readonly name: string; /** Only a date-time or a date is converted, so only those carry a type. */ readonly type?: "timestamptz" | "date" };
/** One printed statement and how to bind it. `row`: it must affect exactly one row. */
export interface Step { readonly sql: string; readonly binds: readonly Recipe[]; readonly row?: boolean }
export type Bound = { readonly sql: string; readonly binds: unknown[]; readonly row?: boolean };

/** The dialect functions the recipes in use call; generated code passes only those. */
export type Values = Partial<Pick<Dialect, "now" | "cutoff" | "timestamp" | "date">> & {
  readonly user?: (recipe: Extract<Recipe, { k: "user" }>, caller: Caller) => unknown;
  readonly isAll?: (caller: Caller, field: string) => boolean;
  readonly scopeInsert?: Dialect['scopeInsert'];
  readonly userRefs?: (recipe: Recipe, caller: Caller) => unknown;
  /** Present only in apps with user fields: keeps, per caller, one printed form of each Schema scope term. */
  readonly scopedAll?: <T>(value: T, caller: Caller) => T;
};
/** A declared date-time or date as the engine stores it; any other value (and `null`) is bound as it is. */
export const encode = (d: Values, type: string | undefined, v: unknown): unknown =>
  type === "timestamptz" ? (v == null ? null : d.timestamp!(v as string | Date)) : type === "date" ? (v == null ? null : d.date!(v as string)) : v;
export function binds(d: Values, recipes: readonly Recipe[], caller: Caller, input?: Readonly<Record<string, unknown>>, ms = 0): unknown[] {
  const out: unknown[] = [];
  for (const r of recipes) {
    switch (r.k) {
      case "uid": if (caller.kind === "host") deny(caller, isAdmin(caller), ""); out.push("subject" in caller ? caller.subject : caller.kind === "system" ? `system:${caller.reason}` : null); break;
      case "admin": out.push(isAdmin(caller) ? 1 : 0); break;
      case "now": out.push(d.now!(ms ||= Date.now())); break;
      case "cutoff": out.push(d.cutoff!(ms ||= Date.now(), r.seconds)); break;
      case "const": out.push(r.value); break;
      case "version": out.push(input!.version); break;
      case "input": out.push(encode(d, r.type, input![r.name]));
        break;
      // Only apps whose plan uses caller values import the version-checked capability; it refuses an unknown recipe, and without it this throws before SQL.
      default: out.push(d.userRefs!(r, caller));
    }
  }
  return out;
}
/** Every step's binds, evaluated for a Procedure. */
export function bound(d: Values, steps: readonly Step[], caller: Caller, input?: Readonly<Record<string, unknown>>): Bound[] {
  const ms = Date.now(); // one clock for the whole Procedure
  return steps.map(s => ({ sql: s.sql, binds: binds(d, s.binds, caller, input, ms), row: s.row }));
}
