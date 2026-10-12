/** Optional app-owned Better Auth configuration; no Better Auth runtime import. */
import { AsyncLocalStorage } from "node:async_hooks";
import type { BetterAuthOptions } from "better-auth/types";
import type { DBAdapter } from "@better-auth/core/db/adapter";
const retention = new AsyncLocalStorage<(task: Promise<unknown>) => void>();
/** Wrap the app's auth handler call with the current Worker's ctx.waitUntil.bind(ctx). Concurrent requests stay isolated. */
export function withAuthTasks<T>(waitUntil: (task: Promise<unknown>) => void, run: () => T): T { return retention.run(waitUntil, run); }
export function retainAuthTask(task: Promise<unknown>): void {
    const settled = task.catch(() => { console.error("[mantle auth] background task failed"); });
    retention.getStore()?.(settled);
}
/** Keyed HMAC prevents enumeration of the six-digit OTP space after a database leak. */
export async function hashEmailOtp(secret: string, otp: string): Promise<string> {
    if (!secret)
        throw new Error("AUTH_SECRET is required for OTP hashing.");
    const bytes = new TextEncoder(), key = await crypto.subtle.importKey("raw", bytes.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, bytes.encode(otp)));
    return btoa(String.fromCharCode(...mac)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}
/** Never default to a client-controlled X-Forwarded-For. The host must overwrite the configured headers. */
export function authHardening({ ipAddressHeaders, plugins = [], baseURL, errorURL = "/" }: {
    ipAddressHeaders: readonly string[];
    plugins?: readonly {
        readonly id: string;
    }[];
    baseURL: string;
    errorURL?: string;
}): Pick<BetterAuthOptions, "advanced" | "rateLimit" | "onAPIError"> {
    const headers = ipAddressHeaders.map(h => h.trim()).filter(Boolean);
    if (!headers.length || headers.some(h => !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(h)))
        throw new Error("ipAddressHeaders must name host-trusted ingress headers.");
    const target = new URL(errorURL, baseURL);
    if (target.origin !== new URL(baseURL).origin)
        throw new Error("Auth errorURL must be same-origin.");
    return { advanced: { ipAddress: { ipAddressHeaders: headers }, backgroundTasks: { handler: retainAuthTask } },
        // ponytail: per-isolate limits; ingress rate limits are needed for distributed quotas.
        rateLimit: { enabled: true, storage: "memory", window: 60, max: plugins.some(p => p.id === "email-otp" || p.id === "magic-link") ? 10 : 100 }, onAPIError: { errorURL: `${target.pathname}${target.search}` } };
}
export type AuthHookContext = {
    path: string;
    params?: Readonly<Record<string, unknown>>;
} | null;
/** Accept the provider-owned profile only on explicitly trusted callbacks, never sign-up/update JSON. */
export function guardGithubLogin(user: Readonly<Record<string, unknown>>, ctx: AuthHookContext, trustedProviders: readonly string[] = ["github"]): {
    data: {
        githubLogin: null;
    };
} | undefined {
    if (!("githubLogin" in user))
        return;
    const provider = ctx?.path === "/callback/:id" ? ctx.params?.id : null;
    if (typeof provider === "string" && trustedProviders.includes(provider))
        return;
    return { data: { githubLogin: null } };
}
export interface SessionCache {
    get(key: string): Promise<string | null>;
    set(key: string, value: string, ttl?: number): Promise<unknown>;
    delete(key: string): Promise<unknown>;
}
/** The already-initialized app auth context; lookup calls use Better Auth's adapter and declared schema mapping. */
export type SessionAuthority = () => Promise<{
    adapter: Pick<DBAdapter, "findOne" | "findMany">;
    options: Pick<BetterAuthOptions, "session" | "verification">;
}>;
/** Database-bound secondaryStorage: KV snapshots are hints only and never vouch for role/session state. */
export function sessionSecondaryStorage(cache: SessionCache, prefix: string, authority: SessionAuthority): NonNullable<BetterAuthOptions["secondaryStorage"]> {
    if (!prefix.trim())
        throw new Error("A unique session-cache namespace is required.");
    const name = (key: string) => `${prefix}:${key}`, verification = (key: string) => key.startsWith("verification:");
    /** A cache write outside verification keys; its failure is logged, not thrown. */
    const optional = async (key: string, work: () => Promise<unknown>) => {
        if (verification(key))
            return;
        try {
            await work();
        }
        catch {
            console.error("[mantle auth] optional session-cache write failed");
        }
    };
    return {
        get: async (key) => {
            if (verification(key))
                return null;
            const context = await authority();
            if (context.options.session?.storeSessionInDatabase !== true || context.options.verification?.storeInDatabase !== true)
                throw new Error("Session secondary storage requires primary database sessions and verification.");
            const { adapter } = context;
            if (key.startsWith("active-sessions-")) {
                const sessions = await adapter.findMany<{
                    token: string;
                    expiresAt: Date | string;
                }>({ model: "session", where: [{ field: "userId", value: key.slice("active-sessions-".length) }], limit: Number.MAX_SAFE_INTEGER });
                return JSON.stringify(sessions.map(s => ({ token: s.token, expiresAt: new Date(s.expiresAt).getTime() })));
            }
            const found = await adapter.findOne<Record<string, unknown> & {
                user?: Record<string, unknown>;
            }>({ model: "session", where: [{ field: "token", value: key }], join: { user: true } });
            if (!found?.user)
                return null;
            const { user, ...session } = found;
            return JSON.stringify({ session, user });
        },
        set: async (key, value, ttl) => {
            await optional(key, () => cache.set(name(key), value, ttl ? Math.max(60, Math.ceil(ttl)) : undefined));
        },
        delete: async (key) => {
            await optional(key, () => cache.delete(name(key)));
        },
        getAndDelete: async () => { throw new Error("Session cache cannot consume verification records."); },
        increment: async () => { throw new Error("Session cache cannot count atomic attempts."); },
    };
}
/** First-deploy facade: failed setup never falls back to an anonymous/successful auth response. */
export const authSetupIncomplete = () => Response.json({ error: { code: "SERVICE_UNAVAILABLE", message: "Authentication setup is incomplete.", path: "auth" } }, { status: 503, headers: { "cache-control": "no-store", "retry-after": "60" } });
