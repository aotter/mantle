/**
 * Match a request path against a Trigger path with OpenAPI-style
 * `{param}` segments. Returns the extracted params on a match, or
 * `null` if the segments don't line up.
 *
 *   matchPath("/api/contact", "/api/contact")       → {}
 *   matchPath("/api/posts/{id}", "/api/posts/abc")  → { id: "abc" }
 *   matchPath("/api/posts/{id}", "/api/posts")      → null
 *   matchPath("/api/posts", "/api/posts/abc")       → null
 *
 * Pure path math — no I/O. Lives in `domain/service/` so adapters
 * (HTTP layer) can call it without dragging an HTTP framework dep.
 */
export function matchPath(
  triggerPath: string,
  requestPath: string,
): Record<string, string> | null {
  return compilePathMatcher(triggerPath)(requestPath);
}

/** Compile the immutable Trigger half once for mounted HTTP routes. */
export function compilePathMatcher(
  triggerPath: string,
): (requestPath: string) => Record<string, string> | null {
  // `/api/posts` and `/api/posts/` are the same resource; without
  // normalization the trailing-slash side gains an empty segment and
  // segment-count alone defeats the match.
  const tParts = stripTrailingSlash(triggerPath).split("/");
  return (requestPath) => {
    const rParts = stripTrailingSlash(requestPath).split("/");
    if (tParts.length !== rParts.length) return null;
    const params: Record<string, string> = {};
    for (let i = 0; i < tParts.length; i++) {
      const t = tParts[i]!;
      const r = rParts[i]!;
      // decodeURIComponent throws URIError on malformed encoding
      // (e.g. `%GG`); surface as a routing miss, not a 500.
      const decoded = safeDecode(r);
      if (decoded === null) return null;
      if (t.startsWith("{") && t.endsWith("}")) {
        params[t.slice(1, -1)] = decoded;
      } else if (t !== decoded) {
        // Decode literals too so `/api/by%2Dtag` matches trigger
        // `/api/by-tag` (percent-encoded equivalent of the same byte).
        return null;
      }
    }
    return params;
  };
}

function safeDecode(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

// Preserve root "/" — only strip when length > 1.
function stripTrailingSlash(p: string): string {
  return p.length > 1 && p.endsWith("/") ? p.slice(0, -1) : p;
}
