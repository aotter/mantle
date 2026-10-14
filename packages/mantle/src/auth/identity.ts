/** Optional identity operations. Better Auth owns access control, writes and user hooks. */
import { adminOptionsOf, type AuthInstance } from "./caller.js";
import { authNames, nativeAuthRead } from "./adapter.js";
import { APIError } from "@better-auth/core/error";
import type { AuthContext } from "@better-auth/core";
import { ContractError, type Caller, type Postgres } from "../kernel/contracts.js";
import { adminLayerOf, rolesFrom } from "../kernel/user-caller.js";
import * as sqlite from "../kernel/dialect/sqlite.js";
import * as postgres from "../kernel/dialect/postgres.js";
import type { Dialect } from "../kernel/dialect/common.js";
import { read as d1Read, type Reader } from "../kernel/driver/d1.js";
import { read as pgRead, transaction } from "../kernel/driver/postgres.js";
type User = { id: string; email: string; name: string; role?: string | null; githubLogin?: string | null; emailVerified: boolean | number; createdAt: string | Date };
type Api = {
    listUsers(input: { headers: Headers; query: Record<string, unknown> }): Promise<{ users: User[]; total: number }>;
    setRole(input: { headers: Headers; body: { userId: string; role: never } }): Promise<unknown>;
    createUser(input: { headers: Headers; body: { email: string; name: string; role: never } }): Promise<{ user: User }>;
    removeUser(input: { headers: Headers; body: { userId: string } }): Promise<unknown>;
    userHasPermission(input: { headers: Headers; body: { permissions: { user: "delete"[] } } }): Promise<{ success: boolean }>;
};
/** Requires Better Auth's official admin plugin. Every API receives the request's headers. */
export interface IdentityAuth extends AuthInstance { readonly api: AuthInstance["api"] & Api }
type Read = (sql: string, values: unknown[]) => PromiseLike<any[]>;
const invalid = (message: string) => new ContractError("INPUT_VALIDATION_FAILED", message, "identity");
type Member = { id: string; email: string; name: string; role: string | null; githubLogin: string | null; emailVerified: boolean; createdAt: Date };
const project = ({ id, email, name, role, githubLogin, emailVerified, createdAt }: User): Member => ({ id, email, name, role: role ?? null, githubLogin: githubLogin ?? null, emailVerified: Boolean(emailVerified), createdAt: new Date(createdAt) });
const literal = (value: string) => "'" + value.replaceAll("'", "''") + "'";
const adminSql = (d: Dialect, auth: Pick<AuthInstance, "options">) => {
    const { column } = nativeAuthRead(auth.options), { adminRoles, adminUserIds } = adminOptionsOf(auth);
    const col = (field: string) => column("user", field);
    return '(' + [...adminRoles.map(role => `${d === sqlite.dialect ? "instr" : "strpos"}(',' || COALESCE(${col("role")}, '') || ',', ${literal(',' + role + ',')}) > 0`), ...adminUserIds.map(id => `${col("id")} = ${literal(id)}`), 'FALSE'].join(' OR ') + ')';
};
/** Translate Better Auth errors at the selected transport boundary, retaining its status and code. */
async function api<T>(run: () => Promise<T>): Promise<T> {
    try { return await run(); }
    catch (error) {
        if (error instanceof APIError) throw new ContractError(error.body?.code ?? "AUTH_DENIED", error.message, "identity", { status: error.statusCode, cause: error });
        throw error;
    }
}
function directory(auth: IdentityAuth, _caller: Caller, headers: Headers, d: Dialect, read: Read) {
    const options = adminOptionsOf(auth), roles = options.adminRoles, privileged = adminSql(d, auth);
    const { table, column, has } = nativeAuthRead(auth.options), col = (field: string) => column("user", field);
    const createdAt = d === sqlite.dialect ? col("createdAt") : postgres.wireTimestamp(col("createdAt")).join("");
    const grantRole = (role = roles[0]) => { if (!role || !roles.includes(role)) throw invalid("Role must be configured in Better Auth adminRoles."); return role; };
    const context = async () => await auth.$context as AuthContext;
    const find = async (id: string) => (await context()).adapter.findOne<User>({ model: "user", where: [{ field: "id", value: id }] });
    const set = async (id: string, role: readonly string[]) => {
        try { await api(() => auth.api.setRole({ headers, body: { userId: id, role: [...(role.length ? role : rolesFrom(options.defaultRole))] as never } })); return true; }
        catch (error) { if (error instanceof ContractError && error.code === "USER_NOT_FOUND") return false; throw error; }
    };
    const remove = async (id: string) => {
        try {
            const found = await find(id);
            await api(() => auth.api.removeUser({ headers, body: { userId: id } }));
            // The admin plugin removes accounts and sessions, but email-OTP proofs are keyed by email.
            if (found) await (await context()).adapter.deleteMany({ model: "verification", where: [{ field: "identifier", operator: "in", value: ["sign-in", "email-verification", "forget-password"].map(t => `${t}-otp-${found.email.toLowerCase()}`) }] });
            return true;
        }
        catch (error) { if (error instanceof ContractError && error.code === "USER_NOT_FOUND") return false; throw error; }
    };
    return {
        adminRoles: roles,
        async listUsers() {
            const query = { sortBy: "createdAt", sortDirection: "asc" };
            let { users, total } = await api(() => auth.api.listUsers({ headers, query }));
            if (users.length < total) ({ users } = await api(() => auth.api.listUsers({ headers, query: { ...query, limit: total } })));
            return users.filter(user => adminLayerOf(user, options)).map(project);
        },
        async listMembers({ search = "", limit = 50, cursor, cursorDirection = "forward" }: {
            search?: string;
            limit?: number;
            cursor?: string;
            cursorDirection?: "forward" | "backward";
        } = {}) {
            await api(() => auth.api.listUsers({ headers, query: { limit: 1 } }));
            if (!Number.isInteger(limit) || limit < 1 || limit > 100 || search.length > 200 || !["forward", "backward"].includes(cursorDirection))
                throw invalid("Invalid member page options.");
            const term = search.trim().toLowerCase(), scope = JSON.stringify(["members", term]);
            let key: [
                string,
                string
            ] | undefined;
            if (cursor) {
                try {
                    const v = JSON.parse(decodeURIComponent(cursor.slice(2)));
                    if (!cursor.startsWith("m:") || !Array.isArray(v) || v.length !== 3 || v[0] !== scope || typeof v[1] !== "string" || !Number.isFinite(Date.parse(v[1])) || typeof v[2] !== "string" || !v[2])
                        throw 0;
                    key = [v[1], v[2]];
                }
                catch {
                    throw invalid("Invalid member cursor for this search.");
                }
            }
            const values: unknown[] = [], bind = (v: unknown) => (values.push(v), d.param(values.length));
            const conditions = [`NOT ${privileged}`];
            if (term) {
                const like = bind(`%${d.escapeLike(term)}%`);
                conditions.push(`(${[`CAST(${col("id")} AS text)`, col("name"), col("email")].map(c => `${c} ${d.like(true)} ${like}${d.likeEscape}`).join(" OR ")})`);
            }
            const backward = cursorDirection === "backward", order = backward ? "DESC" : "ASC", op = backward ? "<" : ">";
            if (key) {
                const time = d.cast(bind(key[0]), "timestamptz"), id = bind(key[1]);
                conditions.push(`(${col("createdAt")} ${op} ${time} OR (${col("createdAt")} = ${time} AND ${col("id")} ${op} ${id}))`);
            }
            const rows = await read(`SELECT ${["id", "email", "name", "role", "githubLogin", "emailVerified"].map(field => `${has("user", field) ? col(field) : "NULL"} AS "${field}"`).join(",")},${createdAt} AS "createdAt" FROM ${table("user")} WHERE ${conditions.join(" AND ")} ORDER BY ${col("createdAt")} ${order},${col("id")} ${order} LIMIT ${limit + 1}`, values);
            const page = rows.slice(0, limit) as User[];
            if (backward)
                page.reverse();
            const encode = (row: User) => `m:${encodeURIComponent(JSON.stringify([scope, typeof row.createdAt === "string" ? row.createdAt : row.createdAt.toISOString(), row.id]))}`;
            return { items: page.map(project), previousCursor: (backward ? rows.length > limit : !!key) && page[0] ? encode(page[0]) : null, nextCursor: (backward ? !!key : rows.length > limit) && page.at(-1) ? encode(page.at(-1)!) : null };
        },
        async setUserRole(id: string, role: string | readonly string[] | null) {
            const user = await find(id), current = rolesFrom(user?.role);
            return set(id, role === null ? current.filter(name => !roles.includes(name)) : typeof role === "string" ? [...new Set([...current, grantRole(role)])] : role);
        },
        async inviteUser(email: string, role?: string) {
            const adminRole = grantRole(role), normalized = email.trim().toLowerCase();
            if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) throw invalid("Invalid invitation email.");
            try {
                const { user } = await api(() => auth.api.createUser({ headers, body: { email: normalized, name: normalized.split("@")[0]!, role: [adminRole] as never } }));
                return { kind: "created" as const, id: user.id };
            }
            catch (error) {
                if (!(error instanceof ContractError) || error.code !== "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL") throw error;
                const { users: [found] } = await api(() => auth.api.listUsers({ headers, query: { filterField: "email", filterValue: normalized, limit: 1 } }));
                if (!found) throw error;
                if (!found.emailVerified) throw new ContractError("AUTH_DENIED", "The existing account must verify its email before receiving admin access.", "identity:invitation");
                await set(found.id, [...new Set([...rolesFrom(found.role), adminRole])]);
                return { kind: "exists" as const, id: found.id };
            }
        },
        async revokeInvite(id: string) {
            const permission = await api(() => auth.api.userHasPermission({ headers, body: { permissions: { user: ["delete"] } } }));
            if (!permission.success) throw new ContractError("AUTH_DENIED", "Invitation revocation requires user:delete.", "identity");
            const user = await find(id);
            if (!user || !adminLayerOf(user, options) || user.emailVerified || await (await context()).adapter.findOne({ model: "account", where: [{ field: "userId", value: id }] })) return false;
            return remove(id);
        },
        deleteUser: remove,
    };
}
export type IdentityDirectory = ReturnType<typeof directory>;
export const d1Identity = (db: Reader, auth: IdentityAuth, caller: Caller, headers: Headers): IdentityDirectory => directory(auth, caller, headers, sqlite.dialect, (sql, v) => d1Read(db, sql, v));
export const postgresIdentity = (db: Postgres, auth: IdentityAuth, caller: Caller, headers: Headers): IdentityDirectory => directory(auth, caller, headers, postgres.dialect, (sql, v) => pgRead(db, sql, v));
export type BootstrapRule = { match: "email" | "github-login"; value: string };
type BootstrapUser = { id: string; email?: string | null; githubLogin?: string | null; emailVerified?: boolean };
const matches = (rule: BootstrapRule, user: BootstrapUser) => (rule.match === "email" ? user.emailVerified === true ? user.email : null : user.githubLogin)?.trim().toLowerCase() === rule.value.trim().toLowerCase();
type BootstrapAuth = Pick<AuthInstance, "options"> | (() => Pick<AuthInstance, "options">);
const promote = (d: Dialect, param: string, source: BootstrapAuth) => {
    const auth = typeof source === "function" ? source() : source, { adminRoles: roles } = adminOptionsOf(auth);
    if (!roles[0]) throw new ContractError("AUTH_CONFIGURATION_ERROR", "Bootstrap requires Better Auth adminRoles.", "identity");
    const { table, column } = authNames(auth.options), role = column("user", "role"), id = column("user", "id");
    return `UPDATE ${table("user")} SET ${role}=${literal(roles[0])} || CASE WHEN COALESCE(${role}, '') = '' THEN '' ELSE ',' || ${role} END WHERE ${id}=${param} AND NOT EXISTS (SELECT 1 FROM ${table("user")} WHERE ${adminSql(d, auth)}) RETURNING ${id}`;
};
/** First-admin bootstrap has no authorized session for setRole; one conditional write elects a single admin. */
function bootstrap(rule: BootstrapRule, update: (id: string) => PromiseLike<unknown[]>) {
    if (!rule.value.trim()) throw invalid("Bootstrap target cannot be empty.");
    return async (user: BootstrapUser): Promise<void> => {
        if (!matches(rule, user)) return;
        if (!(await update(user.id)).length) console.warn("[mantle bootstrap] promotion blocked: admin already exists.");
    };
}
export function d1BootstrapAdmin(db: Reader, rule: BootstrapRule, auth: BootstrapAuth) {
    return bootstrap(rule, id => d1Read(db, promote(sqlite.dialect, "?", auth), [id]));
}
export function postgresBootstrapAdmin(db: Postgres, rule: BootstrapRule, source: BootstrapAuth) {
    return bootstrap(rule, id => transaction(db, async tx => {
        const auth = typeof source === "function" ? source() : source;
        await tx.unsafe("SELECT pg_advisory_xact_lock(hashtext($1))", [authNames(auth.options).table("user")]);
        return tx.unsafe(promote(postgres.dialect, "$1", auth), [id]);
    }, { isolation: "read committed" }, "identity/bootstrap"));
}
