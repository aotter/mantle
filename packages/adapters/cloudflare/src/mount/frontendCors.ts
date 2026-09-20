/** CORS is a transport policy; cookie CSRF and bearer authorization still run. */
export async function withFrontendCors(request: Request, origins: readonly string[], run: () => Promise<Response>): Promise<Response> {
  for (const origin of origins) {
    const url = new URL(origin);
    if (url.origin !== origin || (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))) throw new TypeError("CORS requires exact HTTPS origins (HTTP loopback is allowed)");
  }
  const origin = request.headers.get("origin");
  const allowed = origin !== null && origins.includes(origin);
  const preflight = request.method === "OPTIONS" && request.headers.has("access-control-request-method");
  const methods = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"];
  const requestedHeaders = (request.headers.get("access-control-request-headers") ?? "").split(",").map(value => value.trim().toLowerCase()).filter(Boolean);
  if (preflight && (!allowed || !methods.includes(request.headers.get("access-control-request-method")!) || requestedHeaders.some(header => !["authorization", "content-type"].includes(header)))) return new Response(null, { status: 403, headers: { "cache-control": "private, no-store", vary: "Origin, Access-Control-Request-Method, Access-Control-Request-Headers" } });
  const response = preflight ? new Response(null, { status: 204 }) : await run();
  const headers = new Headers(response.headers);
  // A user-supplied response cannot broaden the host's policy.
  for (const key of [...headers.keys()]) if (key.startsWith("access-control-")) headers.delete(key);
  headers.append("vary", "Origin");
  if (allowed) {
    headers.set("access-control-allow-origin", origin!);
    headers.set("access-control-expose-headers", "WWW-Authenticate");
    if (preflight) {
      headers.set("access-control-allow-methods", methods.join(", "));
      headers.set("access-control-allow-headers", "Authorization, Content-Type");
      headers.append("vary", "Access-Control-Request-Method, Access-Control-Request-Headers");
    }
  }
  if (origin || preflight) headers.set("cache-control", "private, no-store");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
