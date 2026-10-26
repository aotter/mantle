import { ADMIN_API_BASE, canonicalPath, routeOrder, routePath, routeSource } from "../../kernel/route-pattern.js";
import { adminRoutes } from "./targets.js";
import type { AppDescription, DescribeTarget } from "./index.js";

/** A request as a gateway sees it: a REST or Admin method and URL pathname, or an MCP `tools/call` tool name and optional endpoint path. */
export type TargetRequest =
  | { readonly surface: "rest" | "admin"; readonly method: string; readonly path: string }
  | { readonly surface: "mcp"; readonly tool: string; readonly path?: string };
type Meta = DescribeTarget["_meta"];
interface Table { rest: { method: string; pattern: RegExp; view: boolean; meta: Meta }[]; admin: { method: string; pattern: RegExp; meta: Meta }[]; tools: { name: string; endpoints: string[]; meta: Meta }[] }

const tables = new WeakMap<object, Table>();
const route = /^(rest|admin):([A-Z]+) (\/.*)$/;
// Fetch upper-cases these methods and keeps any other spelling; the routers compare the result exactly.
const normalized = new Set(["DELETE", "GET", "HEAD", "OPTIONS", "POST", "PUT"]);

function compile(describe: Pick<AppDescription, "targets">): Table {
  const table: Table = { rest: [], admin: [], tools: [] };
  for (const { name, _meta: meta } of describe.targets) {
    const [, surface, method, template] = route.exec(meta.id) ?? [];
    if (surface === "rest") table.rest.push({ method: method!, pattern: new RegExp(routeSource(routePath(template!)).source), view: meta.variants[0]?.id.startsWith("view:") === true, meta });
    else if (surface === "admin") table.admin.push({ method: method!, pattern: new RegExp(routeSource(routePath(template!), ADMIN_API_BASE).source), meta });
    else {
      // The generated MCP tools: Views on their own surface, Procedures on their `mcp` Trigger surfaces (publishing on admin), media tools on admin.
      const s = meta.surfaces, endpoints = meta.id.startsWith("admin:tool:") ? ["admin"] : meta.id.startsWith("view:") ? s.includes("public") ? ["public"] : s.includes("internal") ? [] : ["admin"]
        : meta.id.startsWith("procedure:") ? s.filter(x => x === "public" || x === "admin") : [];
      if (endpoints.length) table.tools.push({ name, endpoints, meta });
    }
  }
  // The routers' own order: generated REST precedence, and Admin's declared route order.
  const order = (id: string) => adminRoutes.indexOf(id.slice(6) as typeof adminRoutes[number]) >>> 0;
  const path = (id: string) => routePath(id.slice(id.indexOf(" ") + 1));
  table.rest.sort((a, b) => routeOrder(path(a.meta.id), path(b.meta.id)));
  table.admin.sort((a, b) => order(a.meta.id) - order(b.meta.id));
  return table;
}

/**
 * The access target a generated router resolves for a request, from `mantle describe` JSON alone: no application, database
 * or network. REST and Admin take the URL pathname (Admin's under `/admin/api`) and follow the routers' path, method and
 * precedence rules; MCP takes the `tools/call` name and, optionally, the `/mcp` or `/mcp/admin` path. Unserved is null.
 */
export function matchTarget(describe: Pick<AppDescription, "targets">, request: TargetRequest): Meta | null {
  let table = tables.get(describe);
  if (!table) tables.set(describe, table = compile(describe));
  if (request.surface === "mcp") {
    const path = request.path?.replace(/\/+$/, ""), endpoint = path === undefined ? undefined : path === "/mcp" ? "public" : path === "/mcp/admin" ? "admin" : null;
    const found = table.tools.filter(t => t.name === request.tool && (endpoint === undefined || t.endpoints.includes(endpoint!)));
    return endpoint !== null && found.length && found.every(t => t.meta.id === found[0]!.meta.id) ? found[0]!.meta : null;
  }
  const method = normalized.has(request.method.toUpperCase()) ? request.method.toUpperCase() : request.method, path = canonicalPath(request.path);
  if (path === undefined) return null;
  if (request.surface === "admin") {
    if (request.path !== ADMIN_API_BASE && !request.path.startsWith(ADMIN_API_BASE + "/")) return null;
    return table.admin.find(r => r.method === method && r.pattern.test(path))?.meta ?? null;
  }
  // HEAD is served by a View's GET route only.
  return table.rest.find(r => r.pattern.test(path) && (r.method === method || method === "HEAD" && r.method === "GET" && r.view))?.meta ?? null;
}
