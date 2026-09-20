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

/** Index immutable routes; decode each request segment once, preserving input order. */
export function compileRouteMatcher<Route extends { readonly path: string }>(
  routes: readonly Route[],
): (path: string) => { readonly route: Route; readonly params: Record<string, string> } | null {
  interface Node {
    readonly literals: Map<string, Node>;
    parameter?: Node;
    first: number;
    leaf?: { route: Route; rank: number; params: readonly (readonly [string, number])[] };
  }
  const node = (): Node => ({ literals: new Map(), first: Infinity });
  const root = node();
  routes.forEach((route, rank) => {
    let current = root;
    const params: [string, number][] = [];
    for (const [position, part] of stripTrailingSlash(route.path).split("/").entries()) {
      current.first = Math.min(current.first, rank);
      if (part.startsWith("{") && part.endsWith("}")) {
        params.push([part.slice(1, -1), position]);
        current = current.parameter ??= node();
      } else {
        let next = current.literals.get(part);
        if (!next) current.literals.set(part, next = node());
        current = next;
      }
    }
    current.first = Math.min(current.first, rank);
    current.leaf ??= { route, rank, params };
  });
  return (path) => {
    const parts = stripTrailingSlash(path).split("/").map(safeDecode);
    if (parts.includes(null)) return null;
    let best: Node["leaf"];
    // ponytail: overlapping wildcard shapes may visit multiple branches;
    // subtree ranks prune losers. Use a DFA only if ambiguous-route profiles justify it.
    const visit = (current: Node | undefined, depth: number): void => {
      if (!current || current.first >= (best?.rank ?? Infinity)) return;
      if (depth === parts.length) {
        if (current.leaf && current.leaf.rank < (best?.rank ?? Infinity)) best = current.leaf;
        return;
      }
      const literal = current.literals.get(parts[depth]!);
      const parameter = current.parameter;
      if ((literal?.first ?? Infinity) < (parameter?.first ?? Infinity)) {
        visit(literal, depth + 1);
        visit(parameter, depth + 1);
      } else {
        visit(parameter, depth + 1);
        visit(literal, depth + 1);
      }
    };
    visit(root, 0);
    return best ? {
      route: best.route,
      params: Object.fromEntries(best.params.map(([name, position]) => [name, parts[position]!])),
    } : null;
  };
}
