/**
 * What a host's sandbox refuses, found in the built Admin MCP App. The App runs in a host's iframe with no Admin session and no
 * `/admin/api`, and under the CSP the application declared (`defineAdmin({ mcp: { csp } })`), so a build that reaches for any of
 * them fails here instead of in front of a user. `window.open` and `target="_blank"` only warn: the sandbox blocks navigation, so
 * they do nothing, but a component may branch around them.
 *
 * Best effort: it reads the built text for the patterns below, so a URL assembled at run time is not seen. The runtime backstop is
 * the generated compatibility test, which loads the App under the spec's default CSP.
 */

/** `AdminMcpCsp`: the remote origins the App may load from. */
export interface McpCsp {
  readonly connectDomains?: readonly string[];
  readonly resourceDomains?: readonly string[];
  readonly frameDomains?: readonly string[];
  readonly baseUriDomains?: readonly string[];
}

/** Which CSP list a remote use needs: a resource load, a script's request, or a frame. */
export type Kind = "resource" | "connect" | "frame";
const LIST = { resource: "resourceDomains", connect: "connectDomains", frame: "frameDomains" } as const;

export type Hit =
  | { readonly rule: "api" | "cookie" | "open" | "blank" }
  | { readonly rule: "remote"; readonly url: string; readonly kind: Kind };

const API = /\/admin\/api\b/;
const COOKIE = /\bdocument\s*(?:\.\s*cookie\b|\[\s*["'`]cookie["'`]\s*\])/;
const OPEN = /\bwindow\s*\.\s*open\s*\(/;
const BLANK = /\btarget\s*[=:]\s*\\?["'`]_blank/;
/** A string that starts a remote URL: `http(s):` or protocol-relative (and `ws(s):` for sockets). */
const URL_START = String.raw`\\?["'` + "`" + String.raw`]\s*((?:https?:)?\/\/[^"'` + "`" + String.raw`\s\\)]+)`;
const SOCKET_START = String.raw`\\?["'` + "`" + String.raw`]\s*((?:(?:https?|wss?):)?\/\/[^"'` + "`" + String.raw`\s\\)]+)`;
const re = (source: string) => new RegExp(source, "gi");
/** Loads of `kind`, as HTML, JSX, an object or a script has them. `href` of an `<a>` is navigation, so only `<link>` counts. */
const PATTERNS: readonly (readonly [Kind, RegExp])[] = [
  ["frame", re(String.raw`(?:<iframe\b[^>]*?|["']iframe["']\s*,\s*\{[^}]*?)\bsrc\s*[=:]\s*` + URL_START)],
  ["resource", re(String.raw`\b(?:src|poster)\s*[=:]\s*` + URL_START)],
  ["resource", re(String.raw`(?:<link\b[^>]*?|["']link["']\s*,\s*\{[^}]*?)\bhref\s*[=:]\s*` + URL_START)],
  ["resource", re(String.raw`setAttribute\(\s*\\?["'](?:src|href)\\?["']\s*,\s*` + URL_START)],
  ["resource", re(String.raw`\burl\(\s*\\?["']?\s*((?:https?:)?\/\/[^)"'\s\\]+)`)],
  ["resource", re(String.raw`@import\s+(?:url\(\s*)?\\?["']?\s*((?:https?:)?\/\/[^)"'\s\\;]+)`)],
  ["connect", re(String.raw`\bfetch\(\s*` + URL_START)],
  ["connect", re(String.raw`\bnew\s+(?:WebSocket|EventSource)\(\s*` + SOCKET_START)],
  ["connect", re(String.raw`\bimport\(\s*` + URL_START)],
];
const SRCSET = re(String.raw`\bsrcset\s*[=:]\s*\\?["'` + "`" + String.raw`]([^"'` + "`" + String.raw`]*)`);
const IMAGE_SET = re(String.raw`image-set\(([^)]*(?:\([^)]*\)[^)]*)*)\)`);

/** Every rule a piece of source or output breaks. */
export function hitsOf(code: string): Hit[] {
  const hits: Hit[] = [];
  if (API.test(code)) hits.push({ rule: "api" });
  if (COOKIE.test(code)) hits.push({ rule: "cookie" });
  if (OPEN.test(code)) hits.push({ rule: "open" });
  if (BLANK.test(code)) hits.push({ rule: "blank" });
  const found = new Map<string, Hit>();
  const add = (kind: Kind, url: string) => found.set(`${kind} ${url}`, { rule: "remote", url, kind });
  for (const [kind, pattern] of PATTERNS) for (const match of code.matchAll(pattern)) add(kind, match[1]!);
  // every candidate of a srcset, and every string of an image-set
  for (const match of code.matchAll(SRCSET)) for (const candidate of match[1]!.split(",")) { const url = candidate.trim().split(/\s+/)[0]!; if (/^(?:https?:)?\/\//i.test(url)) add("resource", url); }
  for (const match of code.matchAll(IMAGE_SET)) for (const string of match[1]!.matchAll(/["']\s*((?:https?:)?\/\/[^"'\s\\]+)/g)) add("resource", string[1]!);
  // an iframe's src is a frame, not also a resource
  for (const [key, hit] of found) if (hit.rule === "remote" && hit.kind === "resource" && found.has(`frame ${hit.url}`)) found.delete(key);
  return [...hits, ...found.values()];
}

/** The origin a remote URL (or protocol-relative one) names. */
const originOf = (url: string): URL | undefined => { try { return new URL(url.startsWith("//") ? `https:${url}` : url); } catch { return undefined; } };
const DOMAIN = /^(?:(https?|wss?):\/\/)(\*\.)?([a-z0-9-]+(?:\.[a-z0-9-]+)*)(?::(\d+))?$/i;

/** Whether the list `kind` needs covers `url`: a scheme and host, `*.` for any subdomain, a port when given. */
export function declared(url: string, csp: McpCsp | undefined, kind: Kind = "resource"): boolean {
  const target = originOf(url);
  if (!target) return false;
  return (csp?.[LIST[kind]] ?? []).some(domain => {
    const [, scheme, wildcard, host, port] = DOMAIN.exec(domain) ?? [];
    if (!host || `${scheme!.toLowerCase()}:` !== target.protocol || (port ?? "") !== target.port) return false;
    return wildcard ? target.hostname.endsWith(`.${host.toLowerCase()}`) : target.hostname === host.toLowerCase();
  });
}

/** What `defineAdmin({ mcp: { csp } })` declares that a CSP cannot use: a list of origins `https://host[:port]` or `https://*.host`. */
export function cspProblems(csp: McpCsp | undefined): string[] {
  return Object.entries(csp ?? {}).flatMap(([name, list]) => (Array.isArray(list) ? list : [list]).flatMap(domain =>
    typeof domain === "string" && DOMAIN.test(domain) ? [] : [`mcp.csp.${name}: ${JSON.stringify(domain)} is not an origin; write https://host[:port] or https://*.host (no "*", scheme alone or path).`]));
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
 * as lines; an error means the App would break in a host. `libraries` are Mantle's own directories: their code is not the
 * application's, so a hit there only counts for what the host would refuse by itself (it writes the sidebar's cookie only when
 * a browser-only component toggles it) and does not warn.
 */
export function checkMcpApp(html: string, csp: McpCsp | undefined, sources: readonly Source[], { libraries = [] }: { readonly libraries?: readonly string[] } = {}): { readonly errors: string[]; readonly warnings: string[] } {
  const library = (module: string | undefined) => !!module && libraries.some(dir => module.startsWith(dir));
  const same = (a: Hit, b: Hit) => a.rule === b.rule && (a.rule !== "remote" || (b as typeof a).url === a.url);
  const found = (hit: Hit) => sources.filter(source => source.hits.some(other => same(hit, other)));
  const where = (hit: Hit) => {
    const at = found(hit), modules = [...new Set(at.flatMap(source => source.module ?? []))], slots = [...new Set(at.flatMap(source => source.slot ?? []))];
    return `${modules.length ? `in ${modules.join(", ")}` : "in a module the build could not name"}${slots.length ? ` (slot ${slots.join(", ")})` : ""}`;
  };
  const errors: string[] = [];
  for (const hit of hitsOf(html)) {
    if (hit.rule === "api") errors.push(`${where(hit)}: "/admin/api" is Admin's browser route, which a host's App has no session for. Read data through the hooks (useView, useOperation), which call the host's tools.`);
    // the kit's sidebar remembers its state in a cookie: Mantle's own code is not the application's
    else if (hit.rule === "cookie" && !(found(hit).length > 0 && found(hit).every(source => library(source.module)))) errors.push(`${where(hit)}: document.cookie. The App holds no login state; the host's tools run as the caller.`);
    else if (hit.rule === "remote" && !declared(hit.url, csp, hit.kind)) errors.push(`${where(hit)}: ${hit.url} is a remote origin that defineAdmin({ mcp: { csp } }) does not declare in ${LIST[hit.kind]}, so a host would block it. Add its origin there, or bundle the asset into your entry.`);
  }
  const warnings: string[] = [];
  for (const source of sources) {
    if (!source.module || source.module.includes("/node_modules/") || library(source.module)) continue;
    for (const hit of source.hits) {
      if (hit.rule === "open") warnings.push(`${source.module}: window.open does nothing in a host's sandbox. Use <AdminLink> or useOpenLink().`);
      else if (hit.rule === "blank") warnings.push(`${source.module}: target="_blank" does nothing in a host's sandbox. Use <AdminLink> or useOpenLink().`);
    }
  }
  return { errors, warnings: [...new Set(warnings)] };
}
