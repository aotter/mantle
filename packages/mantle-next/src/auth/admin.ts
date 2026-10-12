import { checkOrigin, deny, ContractError, type Caller } from "../kernel/contracts.js";
/** Shared selected-boundary guard. Resolve fresh database authority only for Better Auth's raw admin endpoints. */
export async function guardAuthAdminRequest(request: Request, resolve: () => Caller | Promise<Caller>, basePath = "/api/auth"): Promise<void> {
    let path: string;
    try {
        path = decodeURIComponent(new URL(request.url).pathname).replace(/\/{2,}/g, "/");
    }
    catch {
        throw new ContractError("INPUT_VALIDATION_FAILED", "Malformed auth path.", "request:path");
    }
    if (path.split("/").some(part => part === "." || part === ".."))
        throw new ContractError("INPUT_VALIDATION_FAILED", "Malformed auth path.", "request:path");
    const admin = `${basePath.replace(/\/+$/, "")}/admin`;
    if (path !== admin && !path.startsWith(`${admin}/`))
        return;
    const caller = await resolve();
    deny(caller, caller.kind === "user" && caller.credential === "session" && caller.role === "staff", "auth:admin");
    checkOrigin(request, caller);
}
