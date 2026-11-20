/** Optional app-owned Better Auth configuration; no Better Auth runtime import. */
import { AsyncLocalStorage } from "node:async_hooks";
import type { BetterAuthOptions } from "better-auth/types";
const retention = new AsyncLocalStorage<(task: Promise<unknown>) => void>();
/** Wrap the app's auth handler call with the current Worker's ctx.waitUntil.bind(ctx). Concurrent requests stay isolated. */
export function withAuthTasks<T>(waitUntil: (task: Promise<unknown>) => void, run: () => T): T {
  return retention.run(waitUntil, run);
}
export function retainAuthTask(task: Promise<unknown>): void {
  const settled = task.catch(() => {
    console.error("[mantle auth] background task failed");
  });
  retention.getStore()?.(settled);
}
/** Keyed HMAC prevents enumeration of the six-digit OTP space after a database leak. */
export async function hashEmailOtp(secret: string, otp: string): Promise<string> {
  if (!secret) throw new Error("AUTH_SECRET is required for OTP hashing.");
  const bytes = new TextEncoder(),
    key = await crypto.subtle.importKey("raw", bytes.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
      "sign",
    ]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, bytes.encode(otp)));
  return btoa(String.fromCharCode(...mac))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}
/**
 * RFC 9728/8414 discovery for the default resource `/mcp` and auth base `/api/auth`: fixed public metadata that Better
 * Auth's plugins answer before any endpoint, so GET/HEAD skip the limiter's database read and write. Keys are Better
 * Auth's exact limiter paths (auth base removed); other methods and trailing-slash spellings keep their limit.
 */
const metadataRead = (request: Request, rule: { window: number; max: number }) =>
  (request.method === "GET" || request.method === "HEAD") && !new URL(request.url).pathname.endsWith("/")
    ? (false as const)
    : rule;
const DISCOVERY = Object.fromEntries(
  [
    "/.well-known/oauth-protected-resource",
    "/.well-known/oauth-protected-resource/mcp",
    "/.well-known/oauth-authorization-server",
    "/.well-known/oauth-authorization-server/api/auth",
    "/.well-known/openid-configuration",
  ].map(path => [path, metadataRead]),
);
/** Never default to a client-controlled X-Forwarded-For. The host must overwrite the configured headers. */
export function authHardening({
  ipAddressHeaders,
  baseURL,
  errorURL = "/",
}: {
  ipAddressHeaders: readonly string[];
  baseURL: string;
  errorURL?: string;
}): Pick<BetterAuthOptions, "advanced" | "rateLimit" | "onAPIError"> {
  const headers = ipAddressHeaders.map(h => h.trim()).filter(Boolean);
  if (!headers.length || headers.some(h => !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(h)))
    throw new Error("ipAddressHeaders must name host-trusted ingress headers.");
  const target = new URL(errorURL, baseURL);
  if (target.origin !== new URL(baseURL).origin) throw new Error("Auth errorURL must be same-origin.");
  return {
    advanced: { ipAddress: { ipAddressHeaders: headers }, backgroundTasks: { handler: retainAuthTask } },
    // Shared across isolates; Better Auth's defaults and plugin rules (e.g. 3/min per OTP path) set the limits.
    rateLimit: { enabled: true, storage: "database", customRules: DISCOVERY },
    onAPIError: { errorURL: `${target.pathname}${target.search}` },
  };
}
export type AuthHookContext = {
  path: string;
  params?: Readonly<Record<string, unknown>>;
} | null;
/** Accept the provider-owned profile only on explicitly trusted callbacks, never sign-up/update JSON. */
export function guardGithubLogin(
  user: Readonly<Record<string, unknown>>,
  ctx: AuthHookContext,
  trustedProviders: readonly string[] = ["github"],
):
  | {
      data: {
        githubLogin: null;
      };
    }
  | undefined {
  if (!("githubLogin" in user)) return;
  const provider = ctx?.path === "/callback/:id" ? ctx.params?.id : null;
  if (typeof provider === "string" && trustedProviders.includes(provider)) return;
  return { data: { githubLogin: null } };
}
/** First-deploy facade: failed setup never falls back to an anonymous/successful auth response. */
export const authSetupIncomplete = () =>
  Response.json(
    { error: { code: "SERVICE_UNAVAILABLE", message: "Authentication setup is incomplete.", path: "auth" } },
    { status: 503, headers: { "cache-control": "no-store", "retry-after": "60" } },
  );
