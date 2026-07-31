/** Apply the Worker's final cache decision after OAuth/default dispatch. */
export function applyCachePolicy(request: Request, response: Response): Response {
  const headers = new Headers(response.headers);
  const directives = parseCacheDirectives(headers.get("cache-control"));
  const publicResponse =
    (request.method === "GET" || request.method === "HEAD") &&
    response.status === 200 &&
    request.headers.get("cookie") === null &&
    request.headers.get("authorization") === null &&
    response.headers.get("set-cookie") === null &&
    directives.has("public") &&
    !directives.has("private") &&
    !directives.has("no-store") &&
    !directives.has("no-cache") &&
    hasValidFreshness(directives);

  // These directives override Cache-Control at Cloudflare's edge. The SDK's
  // final policy is authoritative for both public and private responses.
  headers.delete("cdn-cache-control");
  headers.delete("cloudflare-cdn-cache-control");

  if (publicResponse) {
    mergeVary(headers, "Cookie", "Authorization");
  } else {
    headers.set("cache-control", "private, no-store");
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
    webSocket: response.webSocket,
  });
}

function parseCacheDirectives(value: string | null): ReadonlyMap<string, string | null> {
  const directives = new Map<string, string | null>();
  for (const part of (value ?? "").split(",")) {
    const [rawName, rawValue] = part.trim().split("=", 2);
    const name = rawName?.toLowerCase();
    if (name) directives.set(name, rawValue?.trim() ?? null);
  }
  return directives;
}

function hasValidFreshness(directives: ReadonlyMap<string, string | null>): boolean {
  return ["s-maxage", "max-age"].some((name) => {
    const raw = directives.get(name)?.replace(/^"|"$/g, "");
    return raw !== undefined && /^\d+$/.test(raw);
  });
}

function mergeVary(headers: Headers, ...names: string[]): void {
  const current = headers.get("vary");
  if (current?.trim() === "*") return;

  const values = new Map<string, string>();
  for (const value of [...(current?.split(",") ?? []), ...names]) {
    const normalized = value.trim();
    if (normalized) values.set(normalized.toLowerCase(), normalized);
  }
  headers.set("vary", [...values.values()].join(", "));
}
