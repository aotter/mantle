/** Validation runs when an identity is built, outside ordinary query startup. */
import { ContractError } from "./contract-error.js";
import type { Caller, CredentialKind } from "./contracts.js";
import type { AllValues, UserField, UserFields, UserValue } from "./user-fields.js";
import { identities } from "./caller-identity.js";
export const isAllValues = (value: unknown): value is AllValues => !!value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 1 && (value as { all?: unknown }).all === true;
const name = /^[a-z][a-zA-Z0-9_]{0,62}$/;
/** Role names follow Better Auth's role strings; `-` is allowed. */
const roleName = /^[a-z][a-zA-Z0-9_-]{0,62}$/;
const reserved = " id email emailVerified name image createdAt updatedAt role banned banReason banExpires ";
export const validUserFieldName = (field: string): boolean => name.test(field) && !reserved.includes(' '+field+' ') && !field.startsWith("mantle");
const invalid = (message: string): never => { throw new ContractError("USER_FIELD_INVALID", message, "auth:user", { status: 400 }); };
export function valueOf(value: unknown, spec: UserField, field: string): UserValue {
  if (isAllValues(value)) return Object.freeze({ all: true });
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
  if (typeof user.id !== 'string' || !user.id || /^(host|system):/i.test(user.id)) return invalid("User subjects must be non-empty strings without reserved prefixes.");
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
