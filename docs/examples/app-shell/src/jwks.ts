/**
 * Answers this Worker's own JWKS URL in process (aotter/mantle#1932). `resolveCaller` verifies OAuth access tokens
 * with Better Auth's resource client, which fetches `<baseURL>/jwks` by URL: on Workers that is a public-network
 * round trip back into this same Worker (which then reads D1) before most MCP calls, because Better Auth's key cache
 * lives per isolate. Only a GET of exactly that URL is answered here, from `auth.api.getJwks()` (public keys only,
 * the jwt plugin's own rotation and grace rules); Better Auth still verifies the token and its DPoP binding and still
 * caches the keys by that URL, and Mantle still checks the grant. Any other request, or a URL that does not match
 * exactly, uses the real `fetch`. The call skips Better Auth's HTTP router, so it shares no rate-limit bucket and needs
 * no ExecutionContext. A failed key read fails verification as a failed network fetch did.
 * Delete this module once Better Auth's resource client accepts an in-process key source (better-auth/better-auth#11604).
 */
export function withInProcessJwks(outer: typeof fetch, url: string, keys: () => Promise<unknown>): typeof fetch {
  const inProcess = (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const request = input instanceof Request ? input : undefined;
    const method = (init?.method ?? request?.method ?? "GET").toUpperCase();
    return method === "GET" && (request ? request.url : String(input)) === url
      ? keys().then(body => Response.json(body))
      : outer(input, init);
  };
  // keeps whatever else the platform's fetch carries (a runtime may add properties to it)
  return Object.assign(inProcess, outer);
}
