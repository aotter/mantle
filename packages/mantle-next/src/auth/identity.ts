/** Optional identity operations. Better Auth owns permission checks, writes and session-cache invalidation. */
import type { AuthInstance } from "./caller.js";
import { ContractError, deny, type Caller, type Postgres } from "../kernel/contracts.js";
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
            role: "staff" | "user";
        };
    }): Promise<unknown>;
    createUser(input: {
        headers: Headers;
        body: {
            email: string;
            name: string;
            role: "staff";
        };
    }): Promise<{
        user: User;
    }>;
};
/** Requires the official admin plugin with adminRoles: ["staff"]. */
export interface IdentityAuth extends AuthInstance {
    readonly api: AuthInstance["api"] & Api;
}
type Read = (sql: string, values: unknown[]) => PromiseLike<any[]>;
const invalid = (message: string) => new ContractError("INPUT_VALIDATION_FAILED", message, "identity");
/** A staff identity or member as the directory returns it. */
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
function directory(auth: IdentityAuth, caller: Caller, headers: Headers, d: Dialect, read: Read, createdAt: string) {
    const guard = (id?: string) => {
        deny(caller, caller.kind === "user" && caller.credential === "session" && caller.role === "staff", "identity");
        if (caller.kind === "user" && id === caller.subject)
            throw new ContractError("AUTH_DENIED", "You cannot change or delete your own staff identity.", "identity");
    };
    return {
        async listUsers() {
            guard();
            const query = { filterField: "role", filterValue: "staff", sortBy: "createdAt", sortDirection: "asc" };
            let { users, total } = await auth.api.listUsers({ headers, query });
            if (users.length < total)
                ({ users } = await auth.api.listUsers({ headers, query: { ...query, limit: total } }));
            return users.map(project);
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
            const conditions = [`(role IS NULL OR role <> 'staff')`];
            if (term) {
                const like = bind(`%${d.escapeLike(term)}%`);
                conditions.push(`(${["id", "name", "email"].map(c => `${c} ${d.like(true)} ${like}${d.likeEscape}`).join(" OR ")})`);
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
        async setUserRole(id: string, role: "staff" | null) {
            guard(id);
            if (role !== null && role !== "staff")
                throw invalid("Role must be staff or null.");
            if (!(await read(`SELECT id FROM "user" WHERE id=${d.param(1)}`, [id])).length)
                return false;
            await auth.api.setRole({ headers, body: { userId: id, role: role ?? "user" } });
            return true;
        },
        async inviteUser(email: string) {
            guard();
            const normalized = email.trim().toLowerCase();
            if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized))
                throw invalid("Invalid invitation email.");
            try {
                const { user } = await auth.api.createUser({ headers, body: { email: normalized, name: normalized.split("@")[0]!, role: "staff" } });
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
                    throw new ContractError("AUTH_DENIED", "The existing account must verify its email before receiving staff access.", "identity:invitation");
                await auth.api.setRole({ headers, body: { userId: found.id, role: "staff" } });
                return { kind: "exists" as const, id: found.id };
            }
        },
        async revokeInvite(id: string) {
            guard(id);
            // One guarded DELETE; verification/account linking cannot race the eligibility check.
            return (await read(`DELETE FROM "user" WHERE id=${d.param(1)} AND role='staff' AND NOT "emailVerified" AND NOT EXISTS (SELECT 1 FROM account WHERE account."userId"="user".id) RETURNING id`, [id])).length > 0;
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
export const postgresIdentity = (db: Postgres, auth: IdentityAuth, caller: Caller, headers: Headers): IdentityDirectory => directory(auth, caller, headers, postgres.dialect, (sql, v) => pgRead(db, sql, v), postgres.wireTimestamp('"createdAt"').join(""));
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
const promote = (param: string) => `UPDATE "user" SET role='staff' WHERE id=${param} AND NOT EXISTS (SELECT 1 FROM "user" WHERE role='staff') RETURNING id`;
/** Promote the first matching user to staff, only while no staff exists. */
function bootstrap(rule: BootstrapRule, update: (id: string) => PromiseLike<unknown[]>) {
    if (!rule.value.trim())
        throw invalid("Bootstrap target cannot be empty.");
    return async (user: BootstrapUser): Promise<void> => {
        if (!matches(rule, user))
            return;
        if (!(await update(user.id)).length)
            console.warn("[mantle bootstrap] promotion blocked: staff already exists.");
    };
}
export function d1BootstrapStaff(db: Reader, rule: BootstrapRule) {
    return bootstrap(rule, id => d1Read(db, promote("?"), [id]));
}
export function postgresBootstrapStaff(db: Postgres, rule: BootstrapRule) {
    return bootstrap(rule, id => transaction(db, async (tx) => {
        await tx.unsafe("SELECT pg_advisory_xact_lock(1296125516,1)", []);
        return tx.unsafe(promote("$1"), [id]);
    }, { isolation: "read committed" }, "auth/bootstrap"));
}
