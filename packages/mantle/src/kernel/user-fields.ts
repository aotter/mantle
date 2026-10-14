/** Only the original caller carries authority. */
import { ContractError } from "./contract-error.js";
import type { Caller } from "./contracts.js";
import type { Recipe } from './binds.js';

export const USER_REFS_V1 = 1 as const;
/** The typed "every value" state of one field: a structural value, never a magic string. */
export interface AllValues { readonly all: true }
export type UserValue = string | number | readonly (string | number)[] | AllValues;
export interface UserField { readonly type: "string" | "number"; readonly multiple: boolean; readonly enum?: readonly (string | number)[] }
export type UserFields = Readonly<Record<string, UserField>>;
import { valueFor, isHostCaller } from "./caller-identity.js";
import { isAllValues } from "./user-caller.js";
/** Whether the caller holds `{ all: true }` for a field: its row-template term is dropped. */
export const isAll = (caller: Caller, field: string): boolean => isAllValues(valueFor(caller, field));
const SCOPE_TERM = /\/\*s:(\w+)\*\/([^]*?)\/\*\|\*\/([^]*?)\/\*;\*\//g;
/** Generated SQL prints each Schema scope term twice; `{ all: true }` keeps the always-true form, every other caller the filter. */
export const scoped = (sql: string, caller: Caller): string => sql.replace(SCOPE_TERM, (_, field: string, kept: string, all: string) => isAll(caller, field) ? all : kept);
export const scopedAll = <T>(value: T, caller: Caller): T => JSON.parse(JSON.stringify(value), (_key, v) => typeof v === "string" ? scoped(v, caller) : v);
const missing = (caller: Caller, field: string): never => {
  if (isHostCaller(caller)) throw new ContractError("HOST_CONTRACT", `The target needs user field '${field}'.`, "", { status: 412, fields: { field } });
  if (caller.kind === "anonymous") throw new ContractError('UNAUTHENTICATED', `Rows scoped by '${field}' require an authenticated caller.`);
  throw new ContractError('AUTH_DENIED', `The caller has no value for '${field}', which scopes these rows.`);
};
/** Store and Admin share the insert membership check. */
export function scopeInsert(scopes: readonly { readonly column: string; readonly field: string; readonly type: 'string' | 'number' }[], caller: Caller, set: object): object {
  let out = set;
  for (const scope of scopes) {
    const own = ([field]: [string, unknown]) => field.toLowerCase() === scope.column;
    // An optional input forwarded as `undefined` is "not given": autofill or the usual refusal applies, not a scope denial.
    if (Object.entries(out).some(entry => own(entry) && entry[1] === undefined)) out = Object.fromEntries(Object.entries(out).filter(entry => !(own(entry) && entry[1] === undefined)));
    const given = Object.entries(out).find(own);
    if (caller.kind === 'system' || isAll(caller, scope.field)) {
      if (!given) throw new ContractError('INPUT_VALIDATION_FAILED', `An explicit '${scope.column}' value is required.`);
      continue;
    }
    const value = valueFor(caller, scope.field), values = value === undefined ? [] : Array.isArray(value) ? value : [value];
    if (!values.length) missing(caller, scope.field);
    if (given) { if (typeof given[1] !== scope.type || !values.includes(given[1] as string | number)) throw new ContractError('AUTH_DENIED', `The value is outside the caller's '${scope.field}' scope.`); continue; }
    if (values.length !== 1) throw new ContractError('INPUT_VALIDATION_FAILED', `'${scope.column}' is required: the caller holds several '${scope.field}' values.`);
    out = { ...out, [scope.column]: values[0] };
  }
  return out;
}
export { modeOf } from "./caller-identity.js";
export interface UserRecipe extends Extract<Recipe, { k: "user" }> {}
const pgArray = (values: readonly (string | number)[]) => `{${values.map(value => `"${String(value).replace(/[\\"]/g, "\\$&")}"`).join(",")}}`;
/** A missing or empty value is refused here, before any SQL runs; correctness never relies on NULL semantics. */
export const userBinds = (sqlite: boolean) => (recipe: UserRecipe, caller: Caller): unknown => {
  const value = valueFor(caller, recipe.field);
  // An all-values scope still binds its parameter; restrict never widens.
  if (isAllValues(value) && recipe.scope) return sqlite ? "[]" : "{}";
  if (isAllValues(value)) throw new ContractError('AUTH_DENIED', `This target restricts rows by '${recipe.field}', which needs explicit values; { all: true } does not lift a restrict.`);
  const values = value === undefined ? [] : Array.isArray(value) ? value : [value];
  if (!values.length) missing(caller, recipe.field);
  return sqlite ? JSON.stringify(values) : pgArray(values);
};
export const userRefs = (sqlite: boolean, version: number) => {
  if (version !== USER_REFS_V1) throw new ContractError('USER_REFS_VERSION', 'User-reference bind version differs.');
  const user = userBinds(sqlite);
  return (recipe: Recipe, caller: Caller): unknown => {
    if (recipe.k === 'user') return user(recipe, caller);
    throw new ContractError('USER_REFS_VERSION', `Unknown user-reference bind recipe '${recipe.k}'.`);
  };
};

export { roleName, rolesFrom } from "./user-caller.js";
