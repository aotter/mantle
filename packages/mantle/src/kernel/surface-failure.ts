/** Request-time boundary helpers, kept out of the startup chunk that carries ContractError. */
import { ContractError } from "./contract-error.js";
import { wire, type Caller } from "./contracts.js";

/** A cookie is ambient authority; bearer credentials deliberately supplied by the app are not. */
export function checkOrigin(request: Request, caller: Caller): void {
  if (!("credential" in caller) || caller.credential !== "session" || ["GET", "HEAD", "OPTIONS"].includes(request.method)) return;
  const site = request.headers.get("sec-fetch-site"), origin = request.headers.get("origin");
  if ((!site && !origin) || (site && site !== "same-origin" && site !== "none") || (origin && origin !== new URL(request.url).origin))
    throw new ContractError("AUTH_DENIED", "Cross-origin session mutation rejected.", "request:origin");
}

/** A resolver's ContractError (e.g. UNAUTHENTICATED for an expired token) keeps its status; anything else is an application failure. */
export async function surfaceCaller<Env>(request: Request, env: Env, resolve: (request: Request, env: Env, authority: { readonly readOnly: boolean }) => Caller | Promise<Caller>, readOnly = false): Promise<Caller> {
  try { return await resolve(request, env, { readOnly }); } catch (cause) { if (cause instanceof ContractError) throw cause; throw new Error("Caller resolution failed.", {cause}); }
}
/** The client sees the redacted wire form; the log gets the surface (a route or tool, never headers) and the original message, stack and cause. */
export function surfaceError(error: unknown, where = "surface"): ReturnType<typeof wire> {
  const result = wire(error);
  if (result.status === 500) console.error(`[mantle ${where}] unhandled failure`, error);
  return result;
}
export function surfaceFailure(error: unknown, challenge?: string, where?: string): Response {
  const result = surfaceError(error, where);
  return Response.json({error: result.error}, {status: result.status, headers: {"cache-control": "private, no-store", ...(challenge && [401,403].includes(result.status) && result.error.path !== "request:origin" ? {"www-authenticate": challenge} : {})}});
}
