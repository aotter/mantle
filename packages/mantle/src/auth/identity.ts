/** Optional identity operations. Better Auth owns permission checks, writes and session-cache invalidation. */
import { adminRolesOf, type AuthInstance } from "./caller.js";
import { ContractError, isAdmin, deny, type Caller, type Postgres } from "../kernel/contracts.js";
import * as sqlite from "../kernel/dialect/sqlite.js";
import * as postgres from "../kernel/dialect/postgres.js";
import type { Dialect } from "../kernel/dialect/common.js";
import { read as d1Read, type Reader } from "../kernel/driver/d1.js";
import { read as pgRead, transaction } from "../kernel/driver/postgres.js";
type User = {
    id: string;
    email: string;
    name: string;
    role?: string | null;
    githubLogin?: string | null;
    emailVerified: boolean | number;
    createdAt: string | Date;
};
/** Plugin configuration validates dynamic roles before calling Better Auth’s inferred role API. */
type Api = {
    listUsers(input: {
        headers: Headers;
        query: Record<string, unknown>;
    }): Promise<{
        users: User[];
        total: number;
    }>;
    setRole(input: {
        headers: Headers;
        body: {
            userId: string;
            role: never;
        };
    }): Promise<unknown>;
    createUser(input: {
        headers: Headers;
        body: {
            email: string;
            name: string;
            role: never;
        };
    }): Promise<{
        user: User;
    }>;
};
/** Requires the official Better Auth admin plugin; its adminRoles decide the layer. */
export interface IdentityAuth extends AuthInstance {
    readonly api: AuthInstance["api"] & Api;
}
type Read = (sql: string, values: unknown[]) => PromiseLike<any[]>;
const invalid = (message: string) => new ContractError("INPUT_VALIDATION_FAILED", message, "identity");
/** An admin identity or member as the directory returns it. */
type Member = {
    id: string;
    email: string;
    name: string;
    role: string | null;
    githubLogin: string | null;
    emailVerified: boolean;
    createdAt: Date;
};
const project = ({ id, email, name, role, githubLogin, emailVerified, createdAt }: User): Member => ({ id, email, name, role: role ?? null, githubLogin: githubLogin ?? null, emailVerified: Boolean(emailVerified), createdAt: new Date(createdAt) });
/** Uses the default Better Auth model/field names in the template; no boot DDL or seeds. */
const literal = (value: string) => "'" + value.replaceAll("'", "''") + "'";
/** Exact comma-delimited membership, including case; values come only from plugin configuration. */
const adminSql = (d: Dialect, roles: readonly string[], column = 'role') => roles.length ? '(' + roles.map(role => `${d === sqlite.dialect ? "instr" : "strpos"}(',' || COALESCE(${column}, '') || ',', ${literal(',' + role + ',')}) > 0`).join(' OR ') + ')' : 'FALSE';
const holdsAdmin = (roles: readonly string[], role?: string | null) => (role ?? '').split(',').some(name => roles.includes(name));
function directory(auth: IdentityAuth, caller: Caller, headers: Headers, d: Dialect, read: Read, createdAt: string, write: Read = read) {
    const roles = [...adminRolesOf(auth)], privileged = adminSql(d, roles);
    const grantRole = (role = roles[0]) => { if (!role || !roles.includes(role)) throw invalid("Role must be configured in Better Auth adminRoles."); return role; };
    const guard = (id?: string) => {
        deny(caller, isAdmin(caller) && caller.credential === "session", "identity");
        if (caller.kind === "user" && id === caller.subject)
            throw new ContractError("AUTH_DENIED", "You cannot change or delete your own admin identity.", "identity");
    };
    /** One guarded UPDATE leaves admin only while another admin remains; `write` serializes it where one statement is not atomic. */
    const demote = async (id: string): Promise<boolean> => {
        const p = d.param(1);
        if ((await write(`UPDATE "user" SET role='user' WHERE id=${p} AND ${privileged} AND EXISTS (SELECT 1 FROM "user" other WHERE ${adminSql(d, roles, "other.role")} AND COALESCE(other.banned, ${d === sqlite.dialect ? '0' : 'FALSE'}) = ${d === sqlite.dialect ? '0' : 'FALSE'} AND other.id<>${p}) RETURNING id`, [id])).length)
            return true;
        const [user] = await read(`SELECT role FROM "user" WHERE id=${p}`, [id]);
        if (holdsAdmin(roles, user?.role))
            throw new ContractError("CONFLICT", "This is the last admin; promote another admin before removing this one.", "identity");
        return !!user;
    };
    return {
        async listUsers() {
            guard();
            const query = { sortBy: "createdAt", sortDirection: "asc" };
            let { users, total } = await auth.api.listUsers({ headers, query });
            if (users.length < total)
                ({ users } = await auth.api.listUsers({ headers, query: { ...query, limit: total } }));
            return users.filter(user => holdsAdmin(roles, user.role)).map(project);
        },
        async listMembers({ search = "", limit = 50, cursor, cursorDirection = "forward" }: {
            search?: string;
            limit?: number;
            cursor?: string;
            cursorDirection?: "forward" | "backward";
        } = {}) {
            guard();
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
                conditions.push(`(${["CAST(id AS text)", "name", "email"].map(c => `${c} ${d.like(true)} ${like}${d.likeEscape}`).join(" OR ")})`);
            }
            const backward = cursorDirection === "backward", order = backward ? "DESC" : "ASC", op = backward ? "<" : ">";
            if (key) {
                const time = d.cast(bind(key[0]), "timestamptz"), id = bind(key[1]);
                conditions.push(`("createdAt" ${op} ${time} OR ("createdAt" = ${time} AND id ${op} ${id}))`);
            }
            const rows = await read(`SELECT id,email,name,role,"githubLogin","emailVerified",${createdAt} AS "createdAt" FROM "user" WHERE ${conditions.join(" AND ")} ORDER BY "user"."createdAt" ${order},id ${order} LIMIT ${limit + 1}`, values);
            const page = rows.slice(0, limit) as User[];
            if (backward)
                page.reverse();
            const encode = (row: User) => `m:${encodeURIComponent(JSON.stringify([scope, typeof row.createdAt === "string" ? row.createdAt : row.createdAt.toISOString(), row.id]))}`;
            return { items: page.map(project), previousCursor: (backward ? rows.length > limit : !!key) && page[0] ? encode(page[0]) : null, nextCursor: (backward ? !!key : rows.length > limit) && page.at(-1) ? encode(page.at(-1)!) : null };
        },
        async setUserRole(id: string, role: string | null) {
            guard(id);
            if (role !== null) grantRole(role);
            if (role === null)
                return demote(id);
            if (!(await read(`SELECT id FROM "user" WHERE id=${d.param(1)}`, [id])).length)
                return false;
            await auth.api.setRole({ headers, body: { userId: id, role: role as never } });
            return true;
        },
        async inviteUser(email: string, role?: string) {
            guard();
            const adminRole = grantRole(role);
            const normalized = email.trim().toLowerCase();
            if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized))
                throw invalid("Invalid invitation email.");
            try {
                const { user } = await auth.api.createUser({ headers, body: { email: normalized, name: normalized.split("@")[0]!, role: adminRole as never } });
                return { kind: "created" as const, id: user.id };
            }
            catch (error) {
                const e = error as {
                    status?: unknown;
                    body?: {
                        code?: unknown;
                    };
                };
                if (e.status !== "BAD_REQUEST" || e.body?.code !== "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL")
                    throw error;
                const { users: [found] } = await auth.api.listUsers({ headers, query: { filterField: "email", filterValue: normalized, limit: 1 } });
                if (!found)
                    throw error;
                guard(found.id);
                if (!found.emailVerified)
                    throw new ContractError("AUTH_DENIED", "The existing account must verify its email before receiving admin access.", "identity:invitation");
                await auth.api.setRole({ headers, body: { userId: found.id, role: adminRole as never } });
                return { kind: "exists" as const, id: found.id };
            }
        },
        async revokeInvite(id: string) {
            guard(id);
            // One guarded DELETE; verification/account linking cannot race the eligibility check.
            return (await read(`DELETE FROM "user" WHERE id=${d.param(1)} AND ${privileged} AND NOT "emailVerified" AND NOT EXISTS (SELECT 1 FROM account WHERE account."userId"="user".id) RETURNING id`, [id])).length > 0;
        },
        async deleteUser(id: string) {
            guard(id);
            const ctx = await auth.$context as {
                adapter: {
                    deleteMany(input: unknown): Promise<unknown>;
                };
                internalAdapter: {
                    findUserById(id: string): Promise<User | null>;
                    deleteUser(id: string): Promise<unknown>;
                };
            };
            if (!await demote(id))
                return false;
            const found = await ctx.internalAdapter.findUserById(id);
            if (!found)
                return false;
            await ctx.adapter.deleteMany({ model: "verification", where: [{ field: "identifier", operator: "in", value: ["sign-in", "email-verification", "forget-password"].map(t => `${t}-otp-${found.email.toLowerCase()}`) }] });
            await ctx.internalAdapter.deleteUser(id);
            return true;
        },
    };
}
export type IdentityDirectory = ReturnType<typeof directory>;
export const d1Identity = (db: Reader, auth: IdentityAuth, caller: Caller, headers: Headers): IdentityDirectory => directory(auth, caller, headers, sqlite.dialect, (sql, v) => d1Read(db, sql, v), '"createdAt"');
/** One advisory lock orders every statement that changes who is admin (bootstrap included); read committed would let two demotions each see the other admin member. */
const adminWrite = (db: Postgres, sql: string, values: unknown[]) => transaction(db, async (tx) => {
    await tx.unsafe("SELECT pg_advisory_xact_lock(1296125516,1)", []);
    return tx.unsafe(sql, values);
}, { isolation: "read committed" }, "identity/admin");
export const postgresIdentity = (db: Postgres, auth: IdentityAuth, caller: Caller, headers: Headers): IdentityDirectory => directory(auth, caller, headers, postgres.dialect, (sql, v) => pgRead(db, sql, v), postgres.wireTimestamp('"createdAt"').join(""), (sql, v) => adminWrite(db, sql, v));
export type BootstrapRule = {
    match: "email" | "github-login";
    value: string;
};
/** The signed-in user a bootstrap hook inspects. */
type BootstrapUser = {
    id: string;
    email?: string | null;
    githubLogin?: string | null;
    emailVerified?: boolean;
};
const matches = (rule: BootstrapRule, user: BootstrapUser) => (rule.match === "email" ? user.emailVerified === true ? user.email : null : user.githubLogin)?.trim().toLowerCase() === rule.value.trim().toLowerCase();
type BootstrapAuth = Pick<AuthInstance, "options"> | (() => Pick<AuthInstance, "options">);
const promote = (d: Dialect, param: string, auth: BootstrapAuth) => {
    const roles = adminRolesOf(typeof auth === "function" ? auth() : auth);
    if (!roles[0]) throw new ContractError("AUTH_CONFIGURATION_ERROR", "Bootstrap requires Better Auth adminRoles.", "identity");
    return `UPDATE "user" SET role=${literal(roles[0])} WHERE id=${param} AND NOT EXISTS (SELECT 1 FROM "user" WHERE ${adminSql(d, roles)}) RETURNING id`;
};
/** Promote the first matching user to admin, only while no admin exists. */
function bootstrap(rule: BootstrapRule, update: (id: string) => PromiseLike<unknown[]>) {
    if (!rule.value.trim())
        throw invalid("Bootstrap target cannot be empty.");
    return async (user: BootstrapUser): Promise<void> => {
        if (!matches(rule, user))
            return;
        if (!(await update(user.id)).length)
            console.warn("[mantle bootstrap] promotion blocked: admin already exists.");
    };
}
export function d1BootstrapAdmin(db: Reader, rule: BootstrapRule, auth: BootstrapAuth) {
    return bootstrap(rule, id => d1Read(db, promote(sqlite.dialect, "?", auth), [id]));
}
export function postgresBootstrapAdmin(db: Postgres, rule: BootstrapRule, auth: BootstrapAuth) {
    return bootstrap(rule, id => adminWrite(db, promote(postgres.dialect, "$1", auth), [id]));
}
