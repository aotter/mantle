/** Optional app-mounted auth routes; consent and raw admin routes resolve fresh authority. Better Auth owns tokens. */
import { ContractError, type Caller } from "../kernel/contracts.js";
import { checkOrigin, surfaceFailure } from "../kernel/surface-failure.js";
import { draining } from "../kernel/drain.js";
import { guardAuthAdminRequest } from "./admin.js";
import { CONSENT, MAX_BODY, PRIVATE, json, readBody, text } from "./route-http.js";
import { resolveCaller, type AuthInstance, type AuthLoader } from "./caller.js";

export interface AuthRoutesOptions {
  /** Same basePath as app-owned betterAuth options. */
  readonly basePath?: string;
  readonly resolver?: (request: Request) => Caller | Promise<Caller>;
  readonly methods: readonly (
    | { readonly kind: "social"; readonly provider: string }
    | { readonly kind: "oauth"; readonly providerId: string; readonly displayName?: string }
    | { readonly kind: "email-otp" | "magic-link" | "passkey" }
  )[];
  readonly connectedAppsPage?: string;
  // Application seam: applications depend on this. Do not remove or narrow it because Core has no internal use (CONTRIBUTING.md, "Application seams").
  /** The application's name, logo and accent on Core's built-in consent and connected-apps pages; checked here. */
  readonly brand?: ConsentPageBrand;
}

/** Plain values only: the pages escape the name and take no markup. */
export interface ConsentPageBrand {
  readonly name?: string;
  /** An https URL or a same-origin path (`/logo.svg`). */
  readonly logo?: string;
  /**
   * A CSS colour for the primary button and focus ring: hex (3, 4, 6 or 8 digits), or rgb(), rgba(), hsl(), hsla(),
   * lab(), lch(), oklab() or oklch() of three numbers, percentages, angles or `none` (space-separated with an optional
   * `/ alpha`, or comma-separated with an optional fourth).
   */
  readonly primary?: string;
  /** The text on `primary`, in the same forms. */
  readonly primaryForeground?: string;
}

// The value is written into a <style> block, so only these tokens pass: a number with an optional percent or angle
// unit, or `none`; three separated by spaces with an optional `/ alpha`, or three or four separated by commas.
const PART = String.raw`(?:[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?(?:%|deg|g?rad|turn)?|none)`;
const COLOR = new RegExp(
  String.raw`^(?:#(?:[\da-f]{3,4}|[\da-f]{6}|[\da-f]{8})|(?:rgba?|hsla?|oklch|oklab|lab|lch)\(\s*(?:${PART}(?:\s*,\s*${PART}){2,3}|${PART}(?:\s+${PART}){2}(?:\s*/\s*${PART})?)\s*\))$`,
  "i",
);
const COLOR_FORMS =
  "a hex colour (3, 4, 6 or 8 digits) or rgb(), rgba(), hsl(), hsla(), lab(), lch(), oklab() or oklch() of three numbers, percentages, angles (deg, rad, grad, turn) or none, separated by spaces with an optional / alpha, or by commas with an optional fourth";
const sameOriginPath = (path: string) => path.startsWith("/") && !path.startsWith("//") && !/[\\\s]/.test(path);

const basePathOf = (options: { basePath?: string }) => (options.basePath ?? "/api/auth").replace(/\/+$/, "");
const WELL_KNOWN = /^\/\.well-known\/(oauth-authorization-server|oauth-protected-resource)(\/|$)/;

/** The service's auth entry: a Response for a path it owns, `null` for any other. */
export function authRoutes(
  loader: AuthLoader<AuthInstance & { handler(request: Request): Promise<Response> }>,
  options: AuthRoutesOptions,
): (request: Request) => Promise<Response | null> {
  const base = basePathOf(options);
  if (
    options.connectedAppsPage &&
    (!options.connectedAppsPage.startsWith("/") ||
      options.connectedAppsPage.startsWith("//") ||
      /[\\\r\n]/.test(options.connectedAppsPage))
  )
    throw new Error("connectedAppsPage must be a same-origin absolute path.");
  const { logo, primary, primaryForeground } = options.brand ?? {};
  if (logo !== undefined && !sameOriginPath(logo) && !(URL.canParse(logo) && new URL(logo).protocol === "https:"))
    throw new Error("brand.logo must be an https URL or a same-origin path.");
  for (const [key, color] of Object.entries({ primary, primaryForeground }))
    if (color !== undefined && !COLOR.test(color)) throw new Error(`brand.${key} must be ${COLOR_FORMS}.`);
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
        const registration =
          bounded.method === "POST" && pathname === `${base}/oauth2/register`
            ? await loopbackClientsAreNative(bounded)
            : bounded;
        const response = await normalizeAuthResponseCookies(
          await normalizeEmailOtpResponse(await auth.handler(registration)),
        );
        if (response.headers.has("cache-control")) return response;
        // Better Auth states no Cache-Control on most answers (list-sessions, a sign-in redirect): a shared cache would keep them.
        const copy = new Response(response.body, response);
        copy.headers.set("cache-control", PRIVATE["cache-control"]);
        return copy;
      } catch (error) {
        return surfaceFailure(error, undefined, `auth ${route}`);
      }
    }
    if (!CONSENT.has(route)) return null;
    try {
      const caller = await resolve(request);
      checkOrigin(request, caller);
      if (request.method === "POST" && Number(request.headers.get("content-length")) > MAX_BODY)
        return text("request body too large", 413);
      const [{ oauthConsents }, { consentSurface }] = await Promise.all([import("./oauth.js"), import("./consent.js")]);
      return await consentSurface(oauthConsents(await loader.get()), options)(request, caller, route);
    } catch (error) {
      return surfaceFailure(error, undefined, `auth ${route}`);
    }
  });
}

/** Uniform public OTP failures; validation, expiry and attempt budgets remain Better Auth's. */
export async function normalizeEmailOtpResponse(response: Response): Promise<Response> {
  if (
    (response.status !== 400 && response.status !== 403) ||
    response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json"
  )
    return response;
  const error: unknown = await response
    .clone()
    .json()
    .catch(() => null);
  if (
    !error ||
    typeof error !== "object" ||
    !("code" in error) ||
    typeof error.code !== "string" ||
    !["INVALID_OTP", "OTP_EXPIRED", "TOO_MANY_ATTEMPTS"].includes(error.code)
  )
    return response;
  // Do not carry upstream error-state headers into the public response.
  void response.body?.cancel().catch(() => {});
  return Response.json(
    { code: "INVALID_OTP", message: "Invalid OTP" },
    {
      status: 400,
      statusText: "BAD_REQUEST",
      headers: { ...PRIVATE, "content-type": "application/json" },
    },
  );
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
/**
 * A dynamic registration whose every redirect URI is http on a loopback host and that names no application_type is a
 * native app (RFC 8252 7.3): local MCP clients register this way. Better Auth reads the missing type as `web`, which
 * needs https on a non-loopback host, so it would refuse them all. Mark it native, as the client could itself; a
 * registration naming a type, mixing hosts or using any other redirect is passed through unchanged.
 */
export async function loopbackClientsAreNative(request: Request): Promise<Request> {
  const body = (await readBody(request.clone() as Request)
    .then(JSON.parse)
    .catch(error => {
      if (error instanceof ContractError) throw error;
      return null;
    })) as Record<string, unknown> | null;
  const uris = body?.redirect_uris;
  if (
    !body ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    body.application_type !== undefined ||
    !Array.isArray(uris) ||
    !uris.length
  )
    return request;
  const loopback = uris.every(uri => {
    if (typeof uri !== "string" || !URL.canParse(uri)) return false;
    const url = new URL(uri);
    return url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname);
  });
  if (!loopback) return request;
  const headers = new Headers(request.headers);
  headers.delete("content-length");
  return new Request(request.url, {
    method: "POST",
    headers,
    body: JSON.stringify({ ...body, application_type: "native" }),
  });
}

/** Better Auth and host fetch implementations may merge several Set-Cookie values into one header. */
export async function normalizeAuthResponseCookies(response: Response): Promise<Response> {
  if (!response.headers.has("set-cookie")) return response;
  const { splitSetCookieHeader } = await import("better-auth/cookies");
  const values = (response.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie?.() ?? [
    response.headers.get("set-cookie")!,
  ];
  const cookies = values.flatMap(splitSetCookieHeader);
  if (cookies.length < 2) return response;
  const headers = new Headers(response.headers);
  headers.delete("set-cookie");
  for (const cookie of cookies) headers.append("set-cookie", cookie);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
