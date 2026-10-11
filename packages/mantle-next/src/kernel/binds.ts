/**
 * Core's bind recipes (`BindSpec` in the policy rewriter), evaluated for one call. Generated Views, generated
 * Procedures and the Store all bind through this one function. Input recipes carry the authored field name; `version` reads the Store's lock from `input`.
 */
import type { Caller } from "./contracts.js";
import type { Dialect } from "./dialect/common.js";

export type Recipe =
  | { readonly k: "uid" | "role" | "now" | "version" }
  | { readonly k: "cutoff"; readonly seconds: number }
  | { readonly k: "const"; readonly value: unknown }
  | { readonly k: "input"; readonly name: string; readonly type: string };
/** One printed statement and how to bind it. `row`: it must affect exactly one row. */
export interface Step { readonly sql: string; readonly binds: readonly Recipe[]; readonly row?: boolean }
export type Bound = { readonly sql: string; readonly binds: readonly unknown[]; readonly row?: boolean };

/** The dialect functions the recipes in use call; generated code passes only those. */
export type Values = Partial<Pick<Dialect, "now" | "cutoff" | "timestamp" | "date">>;
export function binds(d: Values, recipes: readonly Recipe[], caller: Caller, input?: Readonly<Record<string, unknown>>, ms = 0): unknown[] {
  const out: unknown[] = [];
  for (const r of recipes) {
    switch (r.k) {
      case "uid": out.push(caller.kind === "user" ? caller.subject : caller.kind === "system" ? `system:${caller.reason}` : null); break;
      case "role": out.push(caller.kind === "user" ? caller.role : null); break;
      case "now": out.push(d.now!(ms ||= Date.now())); break;
      case "cutoff": out.push(d.cutoff!(ms ||= Date.now(), r.seconds)); break;
      case "const": out.push(r.value); break;
      case "version": out.push(input!.version); break;
      case "input": {
        const v = input![r.name];
        out.push(r.type === "timestamptz" ? (v == null ? null : d.timestamp!(v as string | Date)) : r.type === "date" ? (v == null ? null : d.date!(v as string)) : v);
      }
    }
  }
  return out;
}
/** Every step's binds, evaluated for a Procedure. */
export function bound(d: Values, steps: readonly Step[], caller: Caller, input?: Readonly<Record<string, unknown>>): Bound[] {
  const ms = Date.now(); // one clock for the whole Procedure
  return steps.map(s => ({ sql: s.sql, binds: binds(d, s.binds, caller, input, ms), row: s.row }));
}
