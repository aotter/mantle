/** App-owned D1 auth.ts template, dynamically imported from the Worker. */
import { betterAuth } from "better-auth/minimal";
import { admin, emailOTP, magicLink, jwt, genericOAuth } from "better-auth/plugins";
import { createAccessControl } from "better-auth/plugins/access";
import { defaultStatements } from "better-auth/plugins/admin/access";
import { d1Adapter, type D1Like } from "../../../src/auth/adapter.js";
import { d1BootstrapStaff } from "../../../src/auth/identity.js";
import { authHardening, guardGithubLogin, hashEmailOtp, sessionSecondaryStorage, type SessionCache, type SessionAuthority } from "../../../src/auth/hardening.js";
import type { BetterAuthOptions } from "better-auth/types";
import { authLoader, resolveCaller } from "../../../src/auth/caller.js";
import { withAuthTasks } from "../../../src/auth/hardening.js";
import { surfaceFailure } from "../../../src/kernel/contracts.js";
import { guardAuthAdminRequest } from "../../../src/auth/admin.js";
const ac = createAccessControl(defaultStatements);
export type Env = {
    DB: D1Like;
    ORIGIN: string;
    AUTH_SECRET: string;
    ADMIN_EMAIL: string;
    SESSION_CACHE?: SessionCache;
    CACHE_NAMESPACE?: string;
    MAIL: {
        otp(args: {
            email: string;
            otp: string;
            type: string;
            locale: string;
        }): Promise<void>;
        link(args: {
            email: string;
            url: string;
            locale: string;
        }): Promise<void>;
    };
};
const locale = (request?: Request) => request?.headers.get("accept-language")?.split(",")[0]?.split(";")[0]?.trim() || "en";
/** Plain options: generate reads plugin schemas without constructing Better Auth or sending queries. */
export function authOptions(env: Env, authority?: SessionAuthority) {
    // CLI schema generation passes an empty env; placeholder values construct no runtime instance.
    const origin = env.ORIGIN || "https://example.invalid", secret = env.AUTH_SECRET || "schema-generation-placeholder-secret";
    const bootstrap = env.ADMIN_EMAIL ? d1BootstrapStaff(env.DB, { match: "email", value: env.ADMIN_EMAIL }) : async () => { };
    const plugins = [admin({ defaultRole: "user", adminRoles: ["staff"], ac, roles: { staff: ac.newRole(defaultStatements), user: ac.newRole({ user: [], session: [] }) } }),
        emailOTP({ storeOTP: { hash: otp => hashEmailOtp(secret, otp) }, sendVerificationOTP: ({ email, otp, type }, ctx) => env.MAIL.otp({ email, otp, type, locale: locale(ctx?.request) }) }),
        magicLink({ storeToken: "hashed", expiresIn: 900, sendMagicLink: ({ email, url }, ctx) => env.MAIL.link({ email, url, locale: locale(ctx?.request) }) }),
        jwt({ disableSettingJwtHeader: true }),
        // Optional generic OAuth login: give each provider a unique id and trusted profile mapper.
        genericOAuth({ config: [] })];
    return { database: d1Adapter(env.DB), secret, baseURL: `${origin}/api/auth`,
        ...authHardening({ ipAddressHeaders: ["cf-connecting-ip"], plugins, baseURL: origin, errorURL: "/admin/sign-in" }),
        plugins,
        user: { additionalFields: { githubLogin: { type: "string", required: false, input: true } } },
        databaseHooks: { user: { create: { before: async (user, ctx) => guardGithubLogin(user, ctx), after: bootstrap }, update: { before: async (user, ctx) => guardGithubLogin(user, ctx), after: bootstrap } } },
        // Read-only opt-in (no KV): add cookieCache: {enabled:true,maxAge:60,refreshCache:false,version:"read-60-v1"}.
        // Pass readOnly:true only for app-classified View/web reads; bump version when enabling/changing this policy.
        session: { storeSessionInDatabase: true }, verification: { storeInDatabase: true },
        ...(env.SESSION_CACHE ? { secondaryStorage: sessionSecondaryStorage(env.SESSION_CACHE, env.CACHE_NAMESPACE!, authority ?? (() => { throw new Error("Session authority is not bound."); })) } : {}) } satisfies BetterAuthOptions;
}
export function createAuth(env: Env) {
    if (!env.AUTH_SECRET || !env.ORIGIN || !env.MAIL)
        throw new Error("Authentication setup is incomplete.");
    let context: ReturnType<SessionAuthority> | undefined;
    const auth = betterAuth(authOptions(env, async () => {
        if (!context)
            throw new Error("Auth context is not ready.");
        return context;
    }));
    context = auth.$context;
    return auth;
}
/** The app mounts this handler, retaining work and guarding Better Auth's raw admin routes with current database facts. */
export function handleAuth(auth: ReturnType<typeof createAuth>, request: Request, waitUntil: (task: Promise<unknown>) => void) {
    return withAuthTasks(waitUntil, async () => {
        try {
            await guardAuthAdminRequest(request, () => resolveCaller(request, authLoader(async () => auth, auth.options.advanced?.cookiePrefix ?? "better-auth")));
            return await auth.handler(request);
        }
        catch (error) {
            return surfaceFailure(error);
        }
    });
}
