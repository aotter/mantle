import { checkOrigin, isAdmin, deny, ContractError, type Caller } from "../kernel/contracts.js";
/** Shared selected-boundary guard. Resolve fresh database authority only for Better Auth's raw admin endpoints. */
export async function guardAuthAdminRequest(request: Request, resolve: () => Caller | Promise<Caller>, basePath = "/api/auth"): Promise<Caller | undefined> {
    let path: string | undefined;
    try {
        path = decodeURIComponent(new URL(request.url).pathname).replace(/\/{2,}/g, "/");
    }
    catch { }
    if (path === undefined || path.split("/").some(part => part === "." || part === ".."))
        throw new ContractError("INPUT_VALIDATION_FAILED", "Malformed auth path.", "request:path");
    const admin = `${basePath.replace(/\/+$/, "")}/admin`;
    if (path !== admin && !path.startsWith(`${admin}/`))
        return;
    const caller = await resolve();
    // Mantle policy: only the admin layer reaches Better Auth admin endpoints (oauth-provider's /admin/oauth2/* admits any
    // session by default); Better Auth access control then decides each action.
    // Any signed-in user may ask about their own permissions or end an impersonation.
    const own = path === `${admin}/has-permission` || path === `${admin}/stop-impersonating`;
    deny(caller, caller.kind === "user" && caller.credential === "session" && (own || isAdmin(caller)), "auth:admin");
    checkOrigin(request, caller);
    return caller;
}
