/** Response hashing is needed only when a Web route actually renders. */
export async function webResponse(
  request: Request,
  body: string,
  type: string,
  cacheControl: string,
  canonical?: string,
): Promise<Response> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body));
  const etag = '"' + Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, "0")).join("") + '"';
  const headers: Record<string, string> = {
    "content-type": type + "; charset=utf-8",
    "cache-control": cacheControl,
    etag,
    "x-content-type-options": "nosniff",
  };
  // A Link target is a URI: a page template's literal characters outside RFC 3986 are percent-encoded here.
  if (canonical)
    headers.link = "<" + canonical.replace(/[^!#$%&-;=?-[\]_a-z~]/gu, encodeURIComponent) + '>; rel="canonical"';
  const cached = request.headers
    .get("if-none-match")
    ?.split(",")
    .some(tag => tag.trim() === "*" || tag.trim().replace(/^W\//, "") === etag);
  return new Response(cached || request.method === "HEAD" ? null : body, { status: cached ? 304 : 200, headers });
}
