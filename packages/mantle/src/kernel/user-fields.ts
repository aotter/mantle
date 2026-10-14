/** Only the original caller carries authority. */
import { ContractError, type Caller, type CredentialKind } from "./contracts.js";
import type { Recipe } from './binds.js';

export const USER_REFS_V1 = 1 as const;
/** The typed "every value" state of one field: a structural value, never a magic string. */
export interface AllValues { readonly all: true }
export type UserValue = string | number | readonly (string | number)[] | AllValues;
export interface UserField { readonly type: "string" | "number"; readonly multiple: boolean; readonly enum?: readonly (string | number)[] }
export type UserFields = Readonly<Record<string, UserField>>;
type Identity = { readonly roles: readonly string[]; readonly fields: Readonly<Record<string, UserValue>>; readonly admin: boolean };
const identities = /* @__PURE__ */ new WeakMap<Caller, Identity>();
const name = /^[a-z][a-zA-Z0-9_]{0,62}$/;
/** Role names follow Better Auth's role strings; `-` is allowed. */
const roleName = /^[a-z][a-zA-Z0-9_-]{0,62}$/;
const reserved = " id email emailVerified name image createdAt updatedAt role banned banReason banExpires ";
export const isAllValues = (value: unknown): value is AllValues => !!value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 1 && (value as { all?: unknown }).all === true;
export const validUserFieldName = (field: string): boolean => name.test(field) && !reserved.includes(' '+field+' ') && !field.startsWith("mantle");
const invalid = (message: string): never => { throw new ContractError("USER_FIELD_INVALID", message, "auth:user", { status: 400 }); };
function valueOf(value: unknown, spec: UserField, field: string): UserValue {
  if (isAllValues(value)) return { all: true };
  const scalar = (value: unknown): string | number => {
    if (typeof value !== spec.type) return invalid(`User field '${field}' must contain ${spec.type} values.`);
    if (typeof value === "number") { if (!Number.isFinite(value)) return invalid(`User field '${field}' must be finite.`); }
    else if (typeof value === "string" && (!(value as string & { isWellFormed(): boolean }).isWellFormed() || value.includes("\0") || new TextEncoder().encode(value).length < 1 || new TextEncoder().encode(value).length > 256))
      return invalid(`User field '${field}' must be 1–256 UTF-8 bytes, without NUL or lone surrogates.`);
    if (spec.enum && !spec.enum.includes(value as string | number)) return invalid(`User field '${field}' is outside its enum.`);
    return value as string | number;
  };
  if (!Array.isArray(value)) return scalar(value);
  if (!spec.multiple) return invalid(`User field '${field}' holds one value.`);
  if (value.length > 64) return invalid(`User field '${field}' accepts at most 64 values.`);
  return Object.freeze([...new Set(value.map(scalar))]);
}
/** Better Auth stores roles comma-separated; split exactly as it does and fail fast on a name no manifest could match. */
function rolesFrom(role: unknown): readonly string[] {
  if (role == null || role === "") return Object.freeze([]);
  if (typeof role !== "string") return invalid("User role must be comma-separated text.");
  return Object.freeze([...new Set(role.split(",").map(part => roleName.test(part) ? part : invalid(`Invalid role '${part}' in '${role}': role names start with a lower-case letter and use letters, digits, '_' or '-'.`)))]);
}
/** Auth integration and test helpers validate a verified Better Auth-shaped user once. */
export function userCaller(user: Readonly<Record<string, unknown>> & { readonly id: string }, options: {
  readonly fields?: UserFields; readonly adminRoles?: readonly string[]; readonly credential?: CredentialKind;
  readonly credentialId?: string | null; readonly clientId?: string | null; readonly scopes?: readonly string[]; readonly issuer?: string;
} = {}): Extract<Caller, { kind: "user" }> {
  if (typeof user.id !== 'string' || !user.id || user.id.startsWith("host:") || user.id.startsWith("system:")) return invalid("User subjects must be non-empty strings without reserved prefixes.");
  const roles = rolesFrom(user.role);
  const fields: Record<string, UserValue> = Object.create(null);
  for (const [field, spec] of Object.entries(options.fields ?? {})) {
    if (!validUserFieldName(field)) return invalid(`Invalid or reserved user field '${field}'.`);
    if (Object.hasOwn(user, field) && user[field] !== undefined && user[field] !== null) fields[field] = valueOf(user[field], spec, field);
  }
  Object.freeze(fields);
  const caller = Object.freeze({ kind: "user" as const, subject: user.id, role: typeof user.role === "string" ? user.role : null,
    admin: roles.some(role => (options.adminRoles ?? ["admin"]).includes(role)), roles, fields,
    ...(options.issuer ? { issuer: options.issuer } : {}), scopes: Object.freeze([...(options.scopes ?? [])]),
    credential: options.credential ?? "session", credentialId: options.credentialId ?? null, clientId: options.clientId ?? null });
  identities.set(caller, Object.freeze({ roles, fields, admin: caller.admin }));
  return caller;
}
export const rolesOf = (caller: Caller): readonly string[] => identities.get(caller)?.roles ?? [];
// Unbranded callers get a fresh empty map; mutating it cannot grant authority.
export const fieldsOf = (caller: Caller): Readonly<Record<string, UserValue>> => identities.get(caller)?.fields ?? {};
const valueFor = (caller: Caller, field: string): UserValue | undefined => identities.get(caller)?.fields[field];
export const hasRole = (caller: Caller, role: string): boolean => rolesOf(caller).includes(role);
export const isAdminCaller = (caller: Caller): boolean => !!identities.get(caller)?.admin;
/** Whether the caller holds `{ all: true }` for a field: its row-template term is dropped. */
export const isAll = (caller: Caller, field: string): boolean => isAllValues(valueFor(caller, field));
const SCOPE_TERM = /\/\*s:(\w+)\*\/([^]*?)\/\*\|\*\/([^]*?)\/\*;\*\//g;
/** Generated SQL prints each Schema scope term twice; `{ all: true }` keeps the always-true form, every other caller the filter. */
export const scoped = (sql: string, caller: Caller): string => sql.replace(SCOPE_TERM, (_, field: string, kept: string, all: string) => isAll(caller, field) ? all : kept);
export const scopedAll = <T>(value: T, caller: Caller): T => JSON.parse(JSON.stringify(value), (_key, v) => typeof v === "string" ? scoped(v, caller) : v);
const missing = (caller: Caller, field: string): never => {
  if (caller.kind === "anonymous") throw new ContractError('UNAUTHENTICATED', `Rows scoped by '${field}' require an authenticated caller.`);
  throw new ContractError('AUTH_DENIED', `The caller has no value for '${field}', which scopes these rows.`);
};
/** Store and Admin share the insert membership check. */
export function scopeInsert(scopes: readonly { readonly column: string; readonly field: string; readonly type: 'string' | 'number' }[], caller: Caller, set: object): object {
  let out = set;
  for (const scope of scopes) {
    const given = Object.entries(out).find(([field]) => field.toLowerCase() === scope.column);
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
export function modeOf(caller: Caller): "caller" | "trusted" {
  const kind = caller.kind;
  if (kind === 'system') return 'trusted';
  if (kind === 'user' || kind === 'anonymous') return 'caller';
  throw new ContractError('AUTH_DENIED', 'Unknown caller');
}
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
