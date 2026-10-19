import type { RuntimePlan } from "../../build/compiler.js";
import type { PlanRestrict } from "../../build/spec/domain/model/RuntimePlan.js";
import { mcpToolNameSegment, mcpTools } from "../../build/spec/domain/service/McpToolNaming.js";
import { resolveLocalizedText, type JsonSchema, type AuthorizationRequirements, type ProcedureMcpAnnotations } from "../../build/spec/domain/model/ManifestGrammar.js";
import { canonical } from "../../build/spec/domain/service/PlanFingerprint.js";
import { mediaDefinitions, publishingInput, publishingTransitions } from "../generated-tools.js";

export interface TargetDefinition {
  id: string;
  name: string;
  surface: string;
  surfaces: string[];
  triggers: { id: string; source: RuntimePlan["triggers"][string]["source"] }[];
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
  trustedOnly: boolean;
  behavior: unknown;
  variants: TargetDefinition[];
}

/** Walk sealed IR, including nested statements and expanded View dependencies. */
export function inspectSql(value: unknown): { schemas: string[]; readSchemas: string[]; readOnly: boolean; writes: { schema: string; operation: string }[] } {
  const schemas = new Set<string>(), readSchemas = new Set<string>();
  const writes: { schema: string; operation: string }[] = [];
  let readOnly = true;
  const walk = (v: unknown): void => {
    if (!v || typeof v !== "object") return;
    const n = v as Record<string, any>;
    if (n.RangeVar?.mantle === "table") { schemas.add(n.RangeVar.relname.toLowerCase()); readSchemas.add(n.RangeVar.relname.toLowerCase()); }
    for (const kind of ["InsertStmt", "UpdateStmt", "DeleteStmt"]) if (n[kind]) {
      readOnly = false;
      if (n[kind].relation?.relname) writes.push({ schema: n[kind].relation.relname.toLowerCase(), operation: kind === "InsertStmt" ? "create" : kind === "UpdateStmt" ? "update" : "delete" });
      if (n[kind].relation?.relname) { schemas.add(n[kind].relation.relname.toLowerCase()); if (kind !== "InsertStmt") readSchemas.add(n[kind].relation.relname.toLowerCase()); }
    }
    Object.values(n).forEach(walk);
  };
  walk(value);
  return { schemas: [...schemas].sort(), readSchemas: [...readSchemas].sort(), readOnly, writes };
}

/** Guards run together; dispatcher variants do not. */
function mergeRestrict(policies: PlanRestrict[], conjunctive: boolean): PlanRestrict {
  return Object.fromEntries([...new Set(policies.flatMap(p => Object.keys(p)))].sort().map(schema => {
    const rows = policies.map(p => p[schema] ?? { terms: [] });
    const terms = [...new Map(rows.flatMap(p => p.terms).map(t => [canonical(t), t])).values()]
      .filter(t => conjunctive || rows.every(p => p.terms.some(v => canonical(v) === canonical(t))));
    const owner = rows.find(p => p.owner)?.owner;
    return [schema, { ...(owner && (conjunctive || rows.every(p => p.owner === owner)) ? { owner } : {}), terms }];
  }));
}

/** Follow guards and write hooks to a fixed point, including writes made by hooks. */
function inspectBehavior(plan: RuntimePlan, ir: unknown, opaque: boolean, requires?: AuthorizationRequirements, restrict?: PlanRestrict, writes?: { schema: string; operation: string }[]) {
  const inspected = inspectSql(ir);
  if (writes) {
    inspected.writes = [...writes];
    inspected.schemas.push(...writes.map(w => w.schema));
    inspected.readSchemas.push(...writes.filter(w => w.operation !== "create").map(w => w.schema));
  }
  const dependencies: unknown[] = [], policies = [restrict ?? {}];
  const procedures = new Set<string>(), hooks = new Set<string>();
  const visit = (name: string): void => {
    if (procedures.has(name)) return;
    procedures.add(name);
    const p = plan.procedures[name];
    if (!p) throw new TypeError(`Unknown dependency '${name}'.`);
    dependencies.push({ procedure: name, declaration: p });
    policies.push(p.restrict ?? {});
    opaque ||= "ref" in p.handler;
    const g = inspectSql("sql" in p.handler ? p.handler.sql.stmts : undefined);
    inspected.schemas.push(...g.schemas); inspected.readSchemas.push(...g.readSchemas); inspected.writes.push(...g.writes);
    inspected.readOnly &&= g.readOnly;
    if (p.requires?.guard) visit(p.requires.guard.procedure);
  };
  if (requires?.guard) visit(requires.guard.procedure);
  for (;;) {
    const before = hooks.size;
    for (const [id, t] of Object.entries(plan.triggers).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      if (t.source.kind !== "lifecycle" || hooks.has(id)) continue;
      const source = t.source;
      if (!opaque && !inspected.writes.some(w => w.schema === source.schema.toLowerCase() && source.on.some(on => on.endsWith(`_${w.operation}`)))) continue;
      hooks.add(id); dependencies.push({ trigger: id, source }); visit(t.procedure);
    }
    if (hooks.size === before) break;
  }
  const related = (names: string[]) => {
    const all = new Set(opaque ? Object.keys(plan.schemas) : names);
    for (const name of all) { const parent = plan.schemas[name]?.translates?.parent.toLowerCase(); if (parent) all.add(parent); }
    return [...all].sort();
  };
  return { ...inspected, schemas: related(inspected.schemas), readSchemas: related(inspected.readSchemas), opaque,
    restrict: mergeRestrict(policies, true), dependencies };
}

const objectInput: JsonSchema = { type: "object", properties: {} };
const pathTemplate = (path: string) => path.replace(/\{([^}]+)\}/g, ":$1");

/** Built-in Admin API templates, relative to the configured Admin API base. */
export const adminRoutes = [
  "GET /me", "GET /site", "GET /collections", "GET /views-manifest", "GET /operations", "GET /webmcp", "POST /webmcp/:tool", "GET /bootstrap",
  "GET /views/:name/export", "GET /views/:name", "GET /view-batch", "GET /developer/views/:name", "POST /operations/:name", "GET /developer-console",
  "GET /collections/:name/statistics", "GET /entries", "GET /entries/export", "GET /entries/:id", "POST /entries", "PATCH /entries/:id",
  "POST /entries/:id/publish", "POST /entries/:id/unpublish", "POST /entries/:id/archive", "DELETE /entries/:id",
  "GET /site-settings", "PATCH /site-settings", "POST /media/uploads", "POST /media/uploads/:groupId/commit", "GET /media", "GET /media/:id", "PATCH /media/:id", "DELETE /media/:id",
  "GET /admin", "GET /members", "PATCH /admin/:id/role", "POST /admin/invitations", "DELETE /admin/invitations/:id",
] as const;

export function targetDefinitions(plan: RuntimePlan): TargetDefinition[] {
  const out: TargetDefinition[] = [];
  const tools = [...mcpTools(plan, "public"), ...mcpTools(plan, "admin")];
  for (const [kind, entries] of [["view", plan.views], ["procedure", plan.procedures]] as const) {
    for (const [name, p] of Object.entries(entries).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
      const view = kind === "view" ? plan.views[name]! : undefined;
      const proc = kind === "procedure" ? plan.procedures[name]! : undefined;
      const ir = view?.stmts ?? (proc && "sql" in proc.handler ? proc.handler.sql.stmts : undefined);
      const inspected = inspectBehavior(plan, ir, !!proc && "ref" in proc.handler, p.requires, p.restrict);
      const tool = tools.find(t => t.kind === kind && t.source === name);
      const title = resolveLocalizedText(p.title, "en", "en") ?? name;
      const triggers = Object.entries(plan.triggers).filter(([, t]) => kind === "procedure" && t.procedure === name).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([id, t]) => ({ id, source: t.source }));
      const surfaces = [...new Set([
        ...(view ? [view.surface, "admin", ...(view.surface === "public" ? ["rest"] : [])] : []),
        ...triggers.map(t => t.source.kind === "mcp" ? t.source.surface : t.source.kind === "http" ? "rest" : t.source.kind),
      ])].sort();
      if (!surfaces.length) surfaces.push("internal");
      out.push({ id: `${kind}:${name}`, name: tool?.name ?? mcpToolNameSegment(name), kind,
        surface: view?.surface ?? (surfaces.includes("public") || surfaces.includes("rest") ? "public" : surfaces.includes("admin") ? "admin" : "internal"), surfaces, triggers,
        title, description: resolveLocalizedText(p.description, "en", "en") ?? title,
        inputSchema: tool?.inputSchema ?? view?.input ?? proc?.input ?? objectInput,
        annotations: tool?.annotations ?? {}, requires: p.requires, restrict: inspected.restrict,
        schemas: inspected.schemas, readSchemas: inspected.readSchemas, readOnly: !inspected.opaque && inspected.readOnly, opaque: inspected.opaque, trustedOnly: !!proc?.trustedOnly,
        variants: [], behavior: { declaration: p, dependencies: inspected.dependencies },
      });
    }
  }
  const addRoute = (id: string, dependencies: TargetDefinition[], inputSchema = objectInput) => {
    const admin = id.startsWith("admin:");
    out.push({ id, name: id.replace(/[^a-zA-Z0-9_-]/g, "_"), title: id, description: id, kind: admin ? "admin" : "rest", surface: admin ? "admin" : "public", surfaces: [admin ? "admin" : "rest"], triggers: dependencies.flatMap(d => d.triggers),
      inputSchema, annotations: {}, requires: admin ? { auth: { all: ["ctx.admin"] } } : dependencies[0]?.requires,
      restrict: mergeRestrict(dependencies.map(d => d.restrict), false),
      schemas: [...new Set(dependencies.flatMap(d => d.schemas))].sort(), readSchemas: [...new Set(dependencies.flatMap(d => d.readSchemas))].sort(),
      readOnly: dependencies.length > 0 && dependencies.every(d => d.readOnly) && (!admin || id.startsWith("admin:GET ") || id === "admin:POST /operations/:name" || id === "admin:POST /webmcp/:tool"),
      opaque: dependencies.some(d => d.opaque), trustedOnly: dependencies.some(d => d.trustedOnly),
      variants: dependencies, behavior: dependencies.map(d => ({ id: d.id, behavior: d.behavior, surfaces: d.surfaces, triggers: d.triggers, input: d.inputSchema, requires: d.requires, restrict: d.restrict, trustedOnly: d.trustedOnly })),
    });
  };
  const declarations = [...out];
  const adminOperations = new Set(mcpTools(plan, "admin").filter(t => t.kind === "procedure").map(t => `procedure:${t.source}`));
  for (const d of declarations) if (d.kind === "view" && d.surfaces.includes("public")) addRoute(`rest:GET /api/views/${d.id.slice(5)}`, [d], d.inputSchema);
  for (const [, t] of Object.entries(plan.triggers).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) if (t.source.kind === "http") {
    const d = declarations.find(d => d.id === `procedure:${t.procedure}`)!;
    addRoute(`rest:${t.source.method} ${pathTemplate(t.source.path)}`, [d], d.inputSchema);
  }
  const generated: TargetDefinition[] = [];
  for (const [schema, s] of Object.entries(plan.schemas).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) if (s.publishing) for (const [verb, from, to] of publishingTransitions) {
    addRoute(`procedure:${s.name}.${verb}`, [], publishingInput);
    const d = out.at(-1)!;
    const inspected = inspectBehavior(plan, undefined, false, undefined, undefined, [{ schema, operation: verb === "publish" ? "publish" : "update" }]);
    Object.assign(d, { kind: "procedure", name: mcpToolNameSegment(`${verb}_${s.name}`), surface: "admin", surfaces: ["admin"], requires: { auth: { all: ["ctx.admin"] } },
      schemas: [...new Set([schema, ...inspected.schemas])].sort(), readSchemas: [...new Set([schema, ...inspected.readSchemas])].sort(), opaque: inspected.opaque,
      behavior: { schema, verb, from, to, dependencies: inspected.dependencies } });
    generated.push(d);
  }
  // Optional mounted media tools are included conservatively: the plan does not record router composition.
  for (const tool of mediaDefinitions()) {
    addRoute(`admin:tool:${tool.name}`, [], tool.inputSchema as JsonSchema);
    const d = out.at(-1)!;
    Object.assign(d, { name: tool.name, readOnly: tool.annotations.readOnlyHint, opaque: !tool.annotations.readOnlyHint, annotations: tool.annotations, behavior: { tool, schemas: plan.schemas } });
    generated.push(d);
  }
  for (const route of adminRoutes) {
    const deps = route.includes("/views/:") || route === "GET /view-batch" ? declarations.filter(d => d.kind === "view" && (route.includes("/developer/") || plan.views[d.id.slice(5)]?.surface === "admin"))
      : route.includes("/operations/:") ? declarations.filter(d => adminOperations.has(d.id)) : route === "POST /webmcp/:tool" ? declarations.filter(d => mcpTools(plan, "admin").some(t => `${t.kind}:${t.source}` === d.id)).concat(generated) : [];
    const generic = route.includes("/entries") || route.includes("/statistics") || route === "GET /bootstrap";
    addRoute(`admin:${route}`, deps, deps.length && route !== "GET /view-batch" ? { ...objectInput, anyOf: deps.map(d => ({ type: "object", properties: { [route.includes("/webmcp/") ? "tool" : "name"]: { type: "string", const: route.includes("/webmcp/") ? d.name : d.id.slice(d.kind === "view" ? 5 : 10) } } })) } : objectInput);
    const d = out.at(-1)!;
    if (generic) {
      const operation = route === "POST /entries" ? "create" : route === "DELETE /entries/:id" ? "delete" : route.startsWith("GET ") ? undefined : route.endsWith("/publish") ? "publish" : "update";
      const inspected = inspectBehavior(plan, undefined, false, undefined, undefined, operation ? Object.keys(plan.schemas).map(schema => ({ schema, operation })) : []);
      d.schemas = Object.keys(plan.schemas).sort(); d.readSchemas = d.schemas; d.opaque = inspected.opaque;
      d.behavior = { schemas: plan.schemas, dependencies: inspected.dependencies };
    }
  }
  return [...new Map(out.map(d => [d.id, d])).values()].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}
