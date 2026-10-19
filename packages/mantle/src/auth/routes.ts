/** Optional app-mounted auth routes; consent and raw admin routes resolve fresh authority. Better Auth owns tokens. */
import { ContractError, type Caller } from "../kernel/contracts.js";
import { checkOrigin, surfaceFailure } from "../kernel/surface-failure.js";
import { draining } from "../kernel/drain.js";
import { guardAuthAdminRequest } from "./admin.js";
import { CONSENT, MAX_BODY, json, readBody, text } from "./route-http.js";
import { resolveCaller, type AuthInstance, type AuthLoader } from "./caller.js";

export interface AuthRoutesOptions {
  /** Same basePath as app-owned betterAuth options. */
  readonly basePath?: string;
  readonly resolver?: (request: Request) => Caller | Promise<Caller>;
  readonly methods: readonly ({ readonly kind: "social"; readonly provider: string } | { readonly kind: "oauth"; readonly providerId: string; readonly displayName?: string } | { readonly kind: "email-otp" | "magic-link" })[];
  readonly connectedAppsPage?: string;
}

const basePathOf = (options: { basePath?: string }) => (options.basePath ?? "/api/auth").replace(/\/+$/, "");
const WELL_KNOWN = /^\/\.well-known\/(oauth-authorization-server|oauth-protected-resource)(\/|$)/;

/** The service's auth entry: a Response for a path it owns, `null` for any other. */
export function authRoutes(loader: AuthLoader<AuthInstance & { handler(request: Request): Promise<Response> }>, options: AuthRoutesOptions): (request: Request) => Promise<Response | null> {
  const base = basePathOf(options);
  if (options.connectedAppsPage && (!options.connectedAppsPage.startsWith("/") || options.connectedAppsPage.startsWith("//") || /[\\\r\n]/.test(options.connectedAppsPage))) throw new Error("connectedAppsPage must be a same-origin absolute path.");
  const resolve = options.resolver ?? ((request: Request) => resolveCaller(request, loader));
  return draining(async request => {
    const { pathname } = new URL(request.url);
    const route = `${request.method} ${pathname}`;
    if (pathname === `${base}/methods` && request.method === "GET") return json({ methods: options.methods });
    if (pathname.startsWith(`${base}/`) || WELL_KNOWN.test(pathname)) {
      const auth = await loader.get();
      if (basePathOf(auth.options) !== base) throw new Error("authRoutes basePath differs from betterAuth options.");
      try {
        const bounded = request.body ? new Request(request, { body: await readBody(request) }) : request;
        await guardAuthAdminRequest(bounded, () => resolve(bounded), base);
        const registration = bounded.method === "POST" && pathname === `${base}/oauth2/register` ? await loopbackClientsAreNative(bounded) : bounded;
        return await normalizeAuthResponseCookies(await auth.handler(registration));
      } catch (error) { return surfaceFailure(error, undefined, `auth ${route}`); }
    }
    if (!CONSENT.has(route)) return null;
    try {
      const caller = await resolve(request);
      checkOrigin(request, caller);
      if (request.method === "POST" && Number(request.headers.get("content-length")) > MAX_BODY) return text("request body too large", 413);
      const [{ oauthConsents }, { consentSurface }] = await Promise.all([import("./oauth.js"), import("./consent.js")]);
      return await consentSurface(oauthConsents(await loader.get()), options)(request, caller, route);
    } catch (error) { return surfaceFailure(error, undefined, `auth ${route}`); }
  });
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
/**
 * A dynamic registration whose every redirect URI is http on a loopback host and that names no application_type is a
 * native app (RFC 8252 7.3): local MCP clients register this way. Better Auth reads the missing type as `web`, which
 * needs https on a non-loopback host, so it would refuse them all. Mark it native, as the client could itself; a
 * registration naming a type, mixing hosts or using any other redirect is passed through unchanged.
 */
export async function loopbackClientsAreNative(request: Request): Promise<Request> {
  const body = await readBody(request.clone() as Request).then(JSON.parse).catch(error => { if (error instanceof ContractError) throw error; return null; }) as Record<string, unknown> | null;
  const uris = body?.redirect_uris;
  if (!body || typeof body !== "object" || Array.isArray(body) || body.application_type !== undefined || !Array.isArray(uris) || !uris.length) return request;
  const loopback = uris.every((uri) => {
    if (typeof uri !== "string" || !URL.canParse(uri)) return false;
    const url = new URL(uri);
    return url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname);
  });
  if (!loopback) return request;
  const headers = new Headers(request.headers);
  headers.delete("content-length");
  return new Request(request.url, { method: "POST", headers, body: JSON.stringify({ ...body, application_type: "native" }) });
}

/** Better Auth and host fetch implementations may merge several Set-Cookie values into one header. */
export async function normalizeAuthResponseCookies(response: Response): Promise<Response> {
  if (!response.headers.has("set-cookie")) return response;
  const { splitSetCookieHeader } = await import("better-auth/cookies");
  const values = (response.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie?.() ?? [response.headers.get("set-cookie")!];
  const cookies = values.flatMap(splitSetCookieHeader);
  if (cookies.length < 2) return response;
  const headers = new Headers(response.headers); headers.delete("set-cookie");
  for (const cookie of cookies) headers.append("set-cookie", cookie);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
