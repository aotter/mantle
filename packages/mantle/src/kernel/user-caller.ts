/** Validation runs when an identity is built, outside ordinary query startup. */
import { ContractError } from "./contract-error.js";
import type { Caller, CredentialKind } from "./contracts.js";
import type { AllValues, UserField, UserFields, UserValue } from "./user-fields.js";
import { validUserFieldName } from "./user-field-name.js";
import { identities } from "./caller-identity.js";
export const isAllValues = (value: unknown): value is AllValues => !!value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 1 && (value as { all?: unknown }).all === true;
/** Role names follow Better Auth's role strings; `-` is allowed. */
export const roleName = /^[a-z][a-zA-Z0-9_-]{0,62}$/;
const invalid = (message: string): never => { throw new ContractError("USER_FIELD_INVALID", message, "auth:user", { status: 400 }); };
function valueOf(value: unknown, spec: UserField, field: string): UserValue {
  if (isAllValues(value)) return Object.freeze({ all: true });
  const scalar = (value: unknown): string | number => {
    if (typeof value !== spec.type) return invalid(`User field '${field}' must contain ${spec.type} values.`);
    if (typeof value === "number") { if (!(spec.integer ? Number.isInteger(value) : Number.isFinite(value))) return invalid(`User field '${field}' must be ${spec.integer ? "an integer" : "finite"}.`); }
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
export function rolesFrom(role: unknown): readonly string[] {
  if (role == null || role === "") return Object.freeze([]);
  if (typeof role !== "string") return invalid("User role must be comma-separated text.");
  return Object.freeze([...new Set(role.split(",").map(part => roleName.test(part) ? part : invalid(`Invalid role '${part}'.`)))]);
}
/** Better Auth's configured admin layer, independent of per-operation access control. */
export function adminLayerOf(user: { id: string; role?: unknown }, options: { adminRoles?: readonly string[]; adminUserIds?: readonly string[] } = {}): boolean {
  return !!options.adminUserIds?.includes(user.id) || rolesFrom(user.role).some(role => (options.adminRoles ?? ["admin"]).some(name => name.trim() === role));
}
/** Auth integration and test helpers validate a verified Better Auth-shaped user once. */
export function userCaller(user: Readonly<Record<string, unknown>> & { readonly id: string }, options: {
  readonly fields?: UserFields; readonly adminRoles?: readonly string[]; readonly adminUserIds?: readonly string[]; readonly credential?: CredentialKind;
  readonly credentialId?: string | null; readonly clientId?: string | null; readonly scopes?: readonly string[]; readonly issuer?: string; readonly impersonatedBy?: string;
} = {}): Extract<Caller, { kind: "user" }> {
  if (typeof user.id !== 'string' || !user.id || /^(host|system):/i.test(user.id)) return invalid("User subjects must be non-empty strings without reserved prefixes.");
  const roles = rolesFrom(user.role);
  const fields: Record<string, UserValue> = Object.create(null);
  for (const [field, spec] of Object.entries(options.fields ?? {})) {
    if (!validUserFieldName(field)) return invalid(`Invalid or reserved user field '${field}'.`);
    if (Object.hasOwn(user, field) && user[field] !== undefined && user[field] !== null) fields[field] = valueOf(user[field], spec, field);
  }
  Object.freeze(fields);
  const caller = { kind: "user" as const, subject: user.id, role: typeof user.role === "string" ? user.role : null,
    admin: adminLayerOf(user, options), roles, fields,
    ...(options.issuer ? { issuer: options.issuer } : {}), scopes: Object.freeze([...(options.scopes ?? [])]),
    credential: options.credential ?? "session", credentialId: options.credentialId ?? null, clientId: options.clientId ?? null };
  // The real actor is read from the brand, so a spread or forged copy never carries it.
  if (options.impersonatedBy) Object.defineProperty(caller, "impersonatedBy", { get() { return identities.get(this)?.impersonatedBy; } });
  identities.set(Object.freeze(caller), Object.freeze({ roles, fields, admin: caller.admin, ...(options.impersonatedBy ? { impersonatedBy: options.impersonatedBy } : {}) }));
  return caller;
}
