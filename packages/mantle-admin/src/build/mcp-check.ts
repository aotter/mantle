/**
 * What a host's sandbox refuses, found in the built Admin MCP App. The App runs in a host's iframe with no Admin session and no
 * `/admin/api`, and under the CSP the application declared (`defineAdmin({ mcp: { csp } })`), so a build that reaches for any of
 * them fails here instead of in front of a user. `window.open` and `target="_blank"` only warn: the sandbox blocks navigation, so
 * they do nothing, but a component may branch around them.
 */

/** `AdminMcpCsp`: the remote origins the App may load from. */
export interface McpCsp {
  readonly connectDomains?: readonly string[];
  readonly resourceDomains?: readonly string[];
  readonly frameDomains?: readonly string[];
  readonly baseUriDomains?: readonly string[];
}

export type Hit =
  | { readonly rule: "api" | "cookie" | "open" | "blank" }
  | { readonly rule: "remote"; readonly url: string };

const API = /\/admin\/api\b/;
const COOKIE = /\bdocument\s*(?:\.\s*cookie\b|\[\s*["'`]cookie["'`]\s*\])/;
const OPEN = /\bwindow\s*\.\s*open\s*\(/;
const BLANK = /\btarget\s*[=:]\s*\\?["'`]_blank/;
/** A remote URL given to `src`, `href`, `poster` or `srcset`, as HTML, JSX or an object has it; to `url()`; to `@import`. */
const REMOTE = [
  /\b(?:src|href|poster|srcset|srcSet)\s*[=:]\s*\\?["'`]\s*((?:https?:)?\/\/[^"'`\s\\)]+)/gi,
  /\burl\(\s*\\?["']?\s*((?:https?:)?\/\/[^)"'\s\\]+)/gi,
  /@import\s+(?:url\(\s*)?\\?["']?\s*((?:https?:)?\/\/[^)"'\s\\;]+)/gi,
];

/** Every rule a piece of source or output breaks. */
export function hitsOf(code: string): Hit[] {
  const hits: Hit[] = [];
  if (API.test(code)) hits.push({ rule: "api" });
  if (COOKIE.test(code)) hits.push({ rule: "cookie" });
  if (OPEN.test(code)) hits.push({ rule: "open" });
  if (BLANK.test(code)) hits.push({ rule: "blank" });
  const urls = new Set<string>();
  for (const pattern of REMOTE) for (const match of code.matchAll(pattern)) urls.add(match[1]!);
  for (const url of urls) hits.push({ rule: "remote", url });
  return hits;
}

/** The origin a remote URL (or protocol-relative one) names. */
const originOf = (url: string): URL | undefined => { try { return new URL(url.startsWith("//") ? `https:${url}` : url); } catch { return undefined; } };

/** Whether any declared domain covers `url`: a host with or without its scheme, `*.` for any subdomain, a port when given. */
export function declared(url: string, csp: McpCsp | undefined): boolean {
  const target = originOf(url);
  if (!target) return false;
  return [csp?.resourceDomains, csp?.connectDomains, csp?.frameDomains, csp?.baseUriDomains].flatMap(list => list ?? []).some(domain => {
    const [, scheme, wildcard, host, port] = /^(?:([a-z][a-z0-9+.-]*):\/\/)?(\*\.)?([^/:*]+)(?::(\d+))?\/?$/i.exec(domain) ?? [];
    if (!host || (scheme && `${scheme.toLowerCase()}:` !== target.protocol) || ((port ?? "") !== target.port)) return false;
    return wildcard ? target.hostname.endsWith(`.${host.toLowerCase()}`) : target.hostname === host.toLowerCase();
  });
}

/** What was found, and where: modules of the build, and slots of the application's definition when they could be read. */
export interface Source {
  readonly module?: string;
  readonly slot?: string;
  readonly hits: readonly Hit[];
}

export const GUIDE = 'the "Customising Admin for MCP hosts" section of docs/handbook/guides/mcp-apps.md (shipped in @aotter/mantle/docs)';

/**
 * `html` is the whole built file; `sources` say which module or slot each hit came from. Returns the build's errors and warnings,
 * as lines; an error means the App would break in a host.
 */
export function checkMcpApp(html: string, csp: McpCsp | undefined, sources: readonly Source[], { libraries = [] }: { readonly libraries?: readonly string[] } = {}): { readonly errors: string[]; readonly warnings: string[] } {
  const same = (a: Hit, b: Hit) => a.rule === b.rule && (a.rule !== "remote" || (b as typeof a).url === a.url);
  const where = (hit: Hit) => {
    const found = sources.filter(source => source.hits.some(other => same(hit, other)));
    const modules = [...new Set(found.flatMap(source => source.module ? [source.module] : []))], slots = [...new Set(found.flatMap(source => source.slot ? [source.slot] : []))];
    return `${modules.length ? `in ${modules.join(", ")}` : "in a module the build could not name"}${slots.length ? ` (slot ${slots.join(", ")})` : ""}`;
  };
  const errors: string[] = [];
  for (const hit of hitsOf(html)) {
    if (hit.rule === "api") errors.push(`${where(hit)}: "/admin/api" is Admin's browser route, which a host's App has no session for. Read data through the hooks (useView, useOperation), which call the host's tools.`);
    else if (hit.rule === "cookie") errors.push(`${where(hit)}: document.cookie. The App holds no login state; the host's tools run as the caller.`);
    else if (hit.rule === "remote" && !declared(hit.url, csp)) errors.push(`${where(hit)}: ${hit.url} is a remote origin that defineAdmin({ mcp: { csp } }) does not declare, so a host would block it. Add its origin to resourceDomains (or connectDomains), or serve the file with your own.`);
  }
  const warnings: string[] = [];
  // Admin's own library, the kit and the packages they use carry these by design: a link opens through the host there
  const own = (module: string) => !module.includes("/node_modules/") && !libraries.some(dir => module.startsWith(dir));
  for (const source of sources) {
    if (!source.module || !own(source.module)) continue;
    for (const hit of source.hits) {
      if (hit.rule === "open") warnings.push(`${source.module}: window.open does nothing in a host's sandbox. Use <AdminLink> or useOpenLink().`);
      else if (hit.rule === "blank") warnings.push(`${source.module}: target="_blank" does nothing in a host's sandbox. Use <AdminLink> or useOpenLink().`);
    }
  }
  return { errors, warnings: [...new Set(warnings)] };
}
