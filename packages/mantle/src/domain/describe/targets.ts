import type { RuntimePlan } from "../../build/compiler.js";
import type { PlanRestrict } from "../../build/spec/domain/model/RuntimePlan.js";
import { mcpToolNameSegment, mcpTools } from "../../build/spec/domain/service/McpToolNaming.js";
import { resolveLocalizedText, type JsonSchema, type AuthorizationRequirements, type ProcedureMcpAnnotations } from "../../build/spec/domain/model/ManifestGrammar.js";

export interface TargetDefinition {
  id: string;
  name: string;
  surface: string;
  kind: "view" | "procedure" | "rest" | "admin";
  title: string;
  description: string;
  inputSchema: JsonSchema;
  annotations: ProcedureMcpAnnotations;
  requires?: AuthorizationRequirements;
  restrict: PlanRestrict;
  schemas: string[];
  readSchemas: string[];
  readOnly: boolean;
  opaque: boolean;
  hostCallable: boolean;
  behavior: unknown;
  variants: TargetDefinition[];
}

/** Walk sealed IR, including nested statements and expanded View dependencies. */
export function inspectSql(value: unknown): { schemas: string[]; readSchemas: string[]; readOnly: boolean } {
  const schemas = new Set<string>(), readSchemas = new Set<string>();
  let readOnly = true;
  const walk = (v: unknown): void => {
    if (!v || typeof v !== "object") return;
    const n = v as Record<string, any>;
    if (n.RangeVar?.mantle === "table") { schemas.add(n.RangeVar.relname.toLowerCase()); readSchemas.add(n.RangeVar.relname.toLowerCase()); }
    for (const kind of ["InsertStmt", "UpdateStmt", "DeleteStmt"]) if (n[kind]) {
      readOnly = false;
      if (n[kind].relation?.relname) { schemas.add(n[kind].relation.relname.toLowerCase()); if (kind !== "InsertStmt") readSchemas.add(n[kind].relation.relname.toLowerCase()); }
    }
    Object.values(n).forEach(walk);
  };
  walk(value);
  return { schemas: [...schemas].sort(), readSchemas: [...readSchemas].sort(), readOnly };
}

const objectInput: JsonSchema = { type: "object", properties: {} };
const pathTemplate = (path: string) => path.replace(/\{([^}]+)\}/g, ":$1");

/** Built-in Admin API templates, relative to the configured Admin API base. */
export const adminRoutes = [
  "GET /me", "GET /site", "GET /collections", "GET /views-manifest", "GET /operations", "GET /webmcp", "POST /webmcp/:tool", "GET /bootstrap",
  "GET /views/:name/export", "GET /views/:name", "GET /developer/views/:name", "POST /operations/:name", "GET /developer-console",
  "GET /collections/:name/statistics", "GET /entries", "GET /entries/export", "GET /entries/:id", "POST /entries", "PATCH /entries/:id",
  "POST /entries/:id/publish", "POST /entries/:id/unpublish", "POST /entries/:id/archive", "DELETE /entries/:id",
  "GET /site-settings", "PATCH /site-settings", "POST /media/uploads", "POST /media/uploads/:groupId/commit", "GET /media", "GET /media/:id", "PATCH /media/:id", "DELETE /media/:id",
  "GET /admin", "GET /members", "PATCH /admin/:id/role", "POST /admin/invitations", "DELETE /admin/invitations/:id",
] as const;

/** Tool inputs flatten path parameters, query selectors and JSON body fields. */
function adminInput(route: string, dependencies: TargetDefinition[], plan: RuntimePlan): JsonSchema {
  const properties: Record<string, JsonSchema> = Object.fromEntries([...route.matchAll(/:([a-zA-Z]+)/g)].map(([, name]) => [name!, { type: "string" }]));
  const required = Object.keys(properties);
  const version: JsonSchema = { anyOf: [{ type: "integer", minimum: 0 }, { type: "string", pattern: "^[0-9]+$" }] };
  if (route.includes("/entries")) properties.collection = { type: "string" };
  if (route.includes("/statistics")) properties.range = { type: "string", enum: ["1h", "24h", "7d", "20d"] };
  if (route.includes("/entries") && !route.startsWith("GET")) properties.expectedVersion = version;
  if (route === "POST /entries" || route === "PATCH /entries/:id") {
    properties.data = { type: "object", anyOf: Object.entries(plan.schemas).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([, s]) => ({ ...s.schema, required: [], properties: Object.fromEntries(Object.entries(s.schema.properties ?? {}).filter(([name]) => name.toLowerCase() !== s.scope)) })) };
  }
  if (route === "GET /entries" || route === "GET /entries/export" || route === "GET /members" || route === "GET /media") Object.assign(properties, {
    limit: { type: "integer", minimum: 1, maximum: route === "GET /members" ? 100 : 500 }, cursor: { type: "string" }, search: { type: "string" },
  });
  if (route === "PATCH /admin/:id/role" || route === "POST /admin/invitations") properties.role = { type: ["string", "null"] };
  if (route === "POST /admin/invitations") properties.email = { type: "string" };
  if (route === "POST /media/uploads") Object.assign(properties, { filename: { type: "string" }, purpose: { type: "string" }, variants: { type: "array", items: { type: "object" } } });
  if (route.startsWith("PATCH /media")) Object.assign(properties, { alt: { type: "string", maxLength: 1000 }, caption: { type: "string", maxLength: 1000 } });
  return { type: "object", properties, ...(required.length ? { required } : {}), ...(dependencies.length ? { anyOf: dependencies.map(d => ({ type: "object", properties: { [route.includes("/webmcp/") ? "tool" : "name"]: { type: "string", const: route.includes("/webmcp/") ? d.name : d.id.slice(d.kind === "view" ? 5 : 10) }, input: d.inputSchema } })) } : {}) };
}

export function targetDefinitions(plan: RuntimePlan): TargetDefinition[] {
  const out: TargetDefinition[] = [];
  const tools = [...mcpTools(plan, "public"), ...mcpTools(plan, "admin")];
  for (const [kind, entries] of [["view", plan.views], ["procedure", plan.procedures]] as const) {
    for (const [name, p] of Object.entries(entries).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
      const view = kind === "view" ? plan.views[name]! : undefined;
      const proc = kind === "procedure" ? plan.procedures[name]! : undefined;
      let opaque = !!proc && "ref" in proc.handler;
      const ir = view?.stmts ?? (proc && "sql" in proc.handler ? proc.handler.sql.stmts : undefined);
      const inspected = inspectSql(ir);
      const guards: unknown[] = [];
      const seen = new Set<string>();
      const guard = (requires: AuthorizationRequirements | undefined): void => {
        const name = requires?.guard?.procedure;
        if (!name || seen.has(name)) return;
        seen.add(name);
        const p = plan.procedures[name];
        if (!p) throw new TypeError(`Unknown guard '${name}'.`);
        guards.push(p);
        if ("ref" in p.handler) { inspected.readOnly = false; opaque = true; }
        else { const g = inspectSql(p.handler.sql.stmts); inspected.schemas.push(...g.schemas); inspected.readSchemas.push(...g.readSchemas); inspected.readOnly &&= g.readOnly; }
        guard(p.requires);
      };
      guard(p.requires);
      // Translation visibility reads the parent even when it is absent from authored IR.
      const related = new Set(inspected.schemas);
      for (const name of related) {
        const parent = plan.schemas[name]?.translates?.parent.toLowerCase();
        if (parent) related.add(parent);
      }
      inspected.schemas = [...related].sort();
      const reads = new Set(inspected.readSchemas);
      for (const name of reads) { const parent = plan.schemas[name]?.translates?.parent.toLowerCase(); if (parent) reads.add(parent); }
      inspected.readSchemas = [...reads].sort();
      const tool = tools.find(t => t.kind === kind && t.source === name);
      const title = resolveLocalizedText(p.title, "en", "en") ?? name;
      const surfaces = Object.values(plan.triggers).flatMap(t => t.procedure === name && t.source.kind === "mcp" ? [t.source.surface] : []);
      out.push({ id: `${kind}:${name}`, name: tool?.name ?? mcpToolNameSegment(name), kind,
        surface: view?.surface ?? (surfaces.includes("admin") ? "admin" : surfaces.includes("public") ? "public" : "internal"),
        title, description: resolveLocalizedText(p.description, "en", "en") ?? title,
        inputSchema: tool?.inputSchema ?? view?.input ?? proc?.input ?? objectInput,
        annotations: tool?.annotations ?? {}, requires: p.requires, restrict: p.restrict ?? {},
        schemas: opaque ? Object.keys(plan.schemas).sort() : inspected.schemas, readSchemas: inspected.readSchemas, readOnly: !opaque && inspected.readOnly, opaque, hostCallable: !proc?.trustedOnly,
        variants: [], behavior: { declaration: p, guards, lowered: kind === "view" ? plan.lowered?.views[name] : plan.lowered?.procedures[name] },
      });
    }
  }
  const addRoute = (id: string, dependencies: TargetDefinition[], inputSchema = objectInput) => {
    const admin = id.startsWith("admin:");
    out.push({ id, name: id.replace(/[^a-zA-Z0-9_-]/g, "_"), title: id, description: id, kind: admin ? "admin" : "rest", surface: admin ? "admin" : "public",
      inputSchema, annotations: {}, requires: admin ? { auth: { all: ["ctx.admin"] } } : dependencies[0]?.requires,
      restrict: Object.fromEntries([...new Set(dependencies.flatMap(d => Object.keys(d.restrict)))].sort().map(schema => {
        const policies = dependencies.flatMap(d => d.restrict[schema] ? [d.restrict[schema]!] : []);
        return [schema, { ...(policies.find(p => p.owner)?.owner ? { owner: policies.find(p => p.owner)!.owner } : {}), terms: policies.flatMap(p => p.terms) }];
      })),
      schemas: [...new Set(dependencies.flatMap(d => d.schemas))].sort(), readSchemas: [...new Set(dependencies.flatMap(d => d.readSchemas))].sort(),
      readOnly: dependencies.every(d => d.readOnly) && (!admin || id.startsWith("admin:GET ") || id === "admin:POST /operations/:name" || id === "admin:POST /webmcp/:tool"),
      opaque: dependencies.some(d => d.opaque), hostCallable: dependencies.every(d => d.hostCallable),
      variants: dependencies, behavior: dependencies.map(d => ({ id: d.id, behavior: d.behavior, requires: d.requires, restrict: d.restrict })),
    });
  };
  const declarations = [...out];
  const adminOperations = new Set(mcpTools(plan, "admin").filter(t => t.kind === "procedure").map(t => `procedure:${t.source}`));
  for (const d of declarations) if (d.kind === "view" && d.surface === "public") addRoute(`rest:GET /api/views/${d.id.slice(5)}`, [d], d.inputSchema);
  for (const [, t] of Object.entries(plan.triggers).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) if (t.source.kind === "http") {
    const d = declarations.find(d => d.id === `procedure:${t.procedure}`)!;
    addRoute(`rest:${t.source.method} ${pathTemplate(t.source.path)}`, [d], d.inputSchema);
  }
  for (const route of adminRoutes) {
    const deps = route.includes("/views/:") ? declarations.filter(d => d.kind === "view" && (route.includes("/developer/") || d.surface === "admin"))
      : route.includes("/operations/:") ? declarations.filter(d => adminOperations.has(d.id)) : route === "POST /webmcp/:tool" ? declarations.filter(d => mcpTools(plan, "admin").some(t => `${t.kind}:${t.source}` === d.id)) : [];
    const generic = route.includes("/entries") || route.includes("/statistics") || route === "GET /bootstrap";
    addRoute(`admin:${route}`, deps, adminInput(route, deps, plan));
    const d = out.at(-1)!;
    if (generic) { d.schemas = Object.keys(plan.schemas).sort(); d.readSchemas = d.schemas; d.behavior = plan.schemas; }
  }
  return [...new Map(out.map(d => [d.id, d])).values()].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}
