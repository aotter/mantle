/**
 * The one path grammar of the generated REST router, the Admin router and describe's `matchTarget`: a route template's
 * pattern, the request path it is tested against and REST precedence. Pure; no database, application or other module.
 */

/** Where Admin serves its API. Admin route templates and `admin:` describe ids are relative to it. */
export const ADMIN_API_BASE = "/admin/api";

/** An http Trigger path as a describe template: `{name}` becomes `:name`. */
export const pathTemplate = (path: string) => path.replace(/\{([^}]+)\}/g, ":$1");

/**
 * A template's anchored pattern source and capture keys. `{name}` and `:name` segments capture one segment; with
 * `suffix`, `{name*}` captures the rest of the path. Other segments match in encoded form. One trailing slash is optional.
 */
export function routeSource(template: string, base = "", suffix = false): { source: string; keys: string[] } {
  const keys: string[] = [];
  const path = template.split("/").map(segment => {
    const rest = suffix ? /^\{([a-zA-Z]\w*)\*\}$/.exec(segment) : null, one = /^\{([^}]+)\}$|^:(.+)$/.exec(segment);
    if (rest || one) { keys.push((rest ?? one)![1] ?? one![2]!); return rest ? "(.*)" : "([^/]+)"; }
    return encodeURIComponent(segment).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }).join("/");
  return { source: `^${base}${path}/?$`, keys };
}

/** The path the routers test: each segment decoded and re-encoded, so equivalent escapes match alike. Malformed escapes are undefined. */
export function canonicalPath(pathname: string): string | undefined {
  try { return pathname.split("/").map(segment => encodeURIComponent(decodeURIComponent(segment))).join("/"); } catch { return undefined; }
}

const isParameter = (segment: string) => segment.startsWith(":") || segment.startsWith("{");
/** REST precedence over describe path templates: fewer parameters, then a literal before a parameter from the left, then the template. */
export function routeOrder(a: string, b: string): number {
  const x = a.split("/"), y = b.split("/");
  const count = (segments: string[]) => segments.filter(isParameter).length;
  if (count(x) !== count(y)) return count(x) - count(y);
  for (let i = 0; i < Math.min(x.length, y.length); i++) if (isParameter(x[i]!) !== isParameter(y[i]!)) return isParameter(x[i]!) ? 1 : -1;
  return a < b ? -1 : a > b ? 1 : 0;
}
