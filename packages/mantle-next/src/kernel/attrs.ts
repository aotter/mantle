/**
 * ADR-0046 caller attributes. Imported only by a generated app whose manifest declares `auth.attributes` and reads them;
 * the generic bind evaluator reaches it through `Values.attr`, so an app without attributes carries none of it.
 * A missing, mistyped or empty attribute binds NULL: the predicate on it matches nothing (fail closed).
 */
import type { Recipe } from "./binds.js";
import { ContractError, type Caller } from "./contracts.js";

type Attr = Extract<Recipe, { k: "attr" }>;
/** The caller's values of one attribute that have the declared type (a scalar is a set of one); null when it has none. */
const values = (r: Attr, caller: Caller): readonly unknown[] | null => {
  const v = caller.kind === "user" ? caller.attrs?.[r.name] : undefined;
  const list = (Array.isArray(v) ? v : v === undefined ? [] : [v]).filter(x => typeof x === r.type);
  return list.length ? list : null;
};
/**
 * One array parameter for a multi-valued attribute, else the scalar. SQLite: JSON text for json_each. PostgreSQL: an array literal sent as text
 * (`CAST(CAST($n AS text) AS text[])`), because Bun.SQL does not encode a JavaScript array for a text[] parameter and postgres.js types it
 * by its own rules; text is sent verbatim by every driver.
 */
const literal = (list: readonly unknown[]) => `{${list.map(x => `"${String(x).replace(/[\\"]/g, "\\$&")}"`).join(",")}}`;
const bind = (json: boolean) => (r: Attr, caller: Caller): unknown => {
  const list = values(r, caller);
  if (r.multiple) return list && (json ? JSON.stringify(list) : literal(list));
  const v = caller.kind === "user" ? caller.attrs?.[r.name] : undefined;
  return typeof v === r.type ? v : null;
};
/** An insert's scope value must be inside the caller's set; an update or delete is checked by the row rules. */
const scope = (r: Attr, caller: Caller, value: unknown, path: string): void => {
  if (!values(r, caller)?.includes(value)) throw new ContractError("AUTH_DENIED", `${path}: the value is outside the caller's '${r.name}' attribute`, path);
};
export const sqlite = { attr: bind(true), anyOf: (column: string, p: string) => `CASE WHEN ${p} IS NULL THEN NULL ELSE ${column} IN (SELECT value FROM json_each(${p})) END`, scope };
export const postgres = { attr: bind(false), anyOf: (column: string, p: string, type: "string" | "number") => `${column} = ANY(CAST(CAST(${p} AS text) AS ${type === "number" ? "float8" : "text"}[]))`, scope };
