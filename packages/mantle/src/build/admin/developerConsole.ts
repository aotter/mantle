/**
 * The Developer console's snapshot (`GET {base}/api/developer-console`), derived from the plan alone: the data model, the logic, the
 * interfaces a caller reaches and the graph between them. Views and inline Procedures show their SQL as authored; the graph reads the
 * IR, so a View's sources and a Procedure's writes are the relations the runtime runs. No run is observed (G7).
 */
import { mcpTools, resolveMantleRef, type AuthPredicate, type AuthorizationRequirements, type JsonSchema, type RuntimePlan, type SqlNode } from "../spec/domain/index.js";
import { procedureFlow, sqlLogic } from "./procedureFlow.js";

type Audience = "public" | "members" | "admin" | "system" | "api-clients";

/** Who a `requires` admits, as the console groups it; null is anyone. */
function audienceOf(requires: AuthorizationRequirements | undefined): Audience | null {
  const all: readonly AuthPredicate[] = requires?.auth?.all ?? [];
  if (all.some((p) => p === "ctx.admin" || typeof p === "object" && "ctx.admin" in p)) return "admin";
  if (all.includes("ctx.user")) return "members";
  if (all.some((p) => p === "ctx.auth" || (typeof p === "object" && "ctx.auth.scope" in p))) return "api-clients";
  return null;
}

/** The Schemas a program reads (every table relation) and writes (a statement's target), by the plan's lower-case key. */
export function relationsOf(stmts: readonly SqlNode[]): { reads: Set<string>; writes: Set<string> } {
  const reads = new Set<string>();
  const writes = new Set<string>();
  const walk = (v: unknown, write: boolean): void => {
    if (Array.isArray(v)) return v.forEach((x) => walk(x, false));
    if (!v || typeof v !== "object") return;
    for (const [k, c] of Object.entries(v as Record<string, unknown>)) {
      const n = c as { relname?: string; mantle?: string } | null;
      // a write's target is a RangeVar without its type key, under `relation`
      if ((k === "RangeVar" || k === "relation") && n && typeof n.relname === "string" && n.mantle !== "cte") (write && k === "relation" ? writes : reads).add(n.relname.toLowerCase());
      walk(c, k === "InsertStmt" || k === "UpdateStmt" || k === "DeleteStmt" || k === "MergeStmt");
    }
  };
  walk(stmts, false);
  return { reads, writes };
}

const pointer = (s: string) => s.replace(/~/g, "~0").replace(/\//g, "~1");

export function developerConsole(plan: RuntimePlan) {
  const schemaName = (key: string) => plan.schemas[key]?.name;
  const schemas = Object.values(plan.schemas).sort((a, b) => a.name.localeCompare(b.name));
  const views = Object.entries(plan.views).sort(([a], [b]) => a.localeCompare(b));
  const procedureAudience = (name: string): Audience => audienceOf(plan.procedures[name]?.requires) ?? "public";
  const handlerOf = (h: RuntimePlan["procedures"][string]["handler"]) =>
    "ref" in h ? { kind: "ref" as const, ref: h.ref } : { kind: "sql" as const, statement: h.source, flow: procedureFlow(h.sql.stmts, relationsOf) };
  const procedures = Object.entries(plan.procedures).sort(([a], [b]) => a.localeCompare(b)).map(([name, p]) => ({
    name, title: p.title ?? null, description: p.description ?? null, audience: procedureAudience(name), input: p.input, output: p.output,
    authorization: p.requires?.auth?.all ?? [], guard: null, handler: handlerOf(p.handler),
    manifest: { ...p, handler: "ref" in p.handler ? p.handler : p.handler.steps ? { steps: p.handler.steps } : { source: p.handler.source } },
  }));
  const triggers = Object.entries(plan.triggers).sort(([a], [b]) => a.localeCompare(b)).map(([name, t]) => ({
    name, target: t.procedure, source: t.source, manifest: t,
    audience: (t.source.kind === "mcp" && t.source.surface === "admin" ? "admin" : procedureAudience(t.procedure)) as Audience,
  }));
  const viewAudience = (v: RuntimePlan["views"][string]): Audience => (v.surface === "internal" ? "system" : v.surface === "admin" ? "admin" : audienceOf(v.requires) ?? "public");

  const relation = (id: string, kind: string, sourceId: string, targetId: string, at: string, value: string) => ({ id, kind, sourceId, targetId, pointer: at, value });
  const relations = [
    ...schemas.flatMap((s) => [
      ...(s.translates ? [relation(`Schema:${s.name}:translates:${s.translates.parent}`, "translation-parent", `Schema:${s.name}`, `Schema:${s.translates.parent}`, "/spec/translates/parent", s.translates.parent)] : []),
      ...Object.entries((s.schema.properties ?? {}) as Record<string, JsonSchema>).flatMap(([field, property]) => {
        const target = resolveMantleRef(property)?.schema;
        return target && schemaName(target.toLowerCase()) ? [relation(`Schema:${s.name}:field:${field}:${target}`, "schema-reference", `Schema:${s.name}`, `Schema:${target}`, `/spec/schema/properties/${pointer(field)}/x-mantle-ref`, target)] : [];
      }),
    ]),
    ...views.flatMap(([name, v]) => [
      ...[...relationsOf(v.stmts).reads].flatMap((key) => (schemaName(key) ? [relation(`View:${name}:from:${schemaName(key)}`, "view-source", `View:${name}`, `Schema:${schemaName(key)}`, "/spec/sql", schemaName(key)!)] : [])),
    ]),
    ...Object.entries(plan.procedures).flatMap(([name, p]) => [
      // what the Procedure writes: its SQL's targets, or the target a `ref` handler declares
      ...("sql" in p.handler ? [...relationsOf(p.handler.sql.stmts).writes].map(schemaName) : [p.target && schemaName(p.target.schema.toLowerCase())]).flatMap((s) => (s ? [relation(`Procedure:${name}:writes:${s}`, "procedure-schema", `Procedure:${name}`, `Schema:${s}`, "sql" in p.handler ? "/spec/handler/sql" : "/spec/target/schema", s)] : [])),
    ]),
    ...Object.entries(plan.triggers).map(([name, t]) => relation(`Trigger:${name}:target:${t.procedure}`, "trigger-target", `Trigger:${name}`, `Procedure:${t.procedure}`, "/spec/target/procedure", t.procedure)),
  ].sort((a, b) => a.id.localeCompare(b.id));

  const callable = (["public", "admin"] as const).flatMap((surface) => mcpTools(plan, surface).map((tool) => ({
    kind: tool.kind, name: tool.name, target: tool.source, surface, audience: surface === "admin" ? "admin" : audienceOf(tool.requires) ?? "public",
    title: tool.title ?? null, description: tool.description, input: tool.inputSchema, output: tool.outputSchema ?? null,
    trigger: tool.kind === "procedure" ? Object.entries(plan.triggers).find(([, t]) => t.procedure === tool.source && t.source.kind === "mcp" && t.source.surface === surface)?.[0] ?? null : null,
  })));
  const http = [
    ...Object.entries(plan.triggers).flatMap(([name, t]) => {
      if (t.source.kind !== "http") return [];
      const p = plan.procedures[t.procedure]!;
      return [{ kind: "procedure" as const, name, target: t.procedure, method: t.source.method, path: t.source.path, audience: procedureAudience(t.procedure), title: typeof p.title === "string" ? p.title : null, description: typeof p.description === "string" ? p.description : `Invoke Procedure '${t.procedure}'.`, input: p.input, output: p.output }];
    }),
    // the preset mounts REST at /api
    ...views.filter(([, v]) => v.surface === "public").map(([name, v]) => ({ kind: "view" as const, name, target: name, method: "GET", path: `/api/views/${name}`, audience: viewAudience(v), title: typeof v.title === "string" ? v.title : null, description: typeof v.description === "string" ? v.description : `Read View '${name}'.`, input: v.input ?? { type: "object" }, output: null })),
  ].sort((a, b) => `${a.path}\0${a.method}`.localeCompare(`${b.path}\0${b.method}`));

  return {
    dataModel: {
      schemas: schemas.map((s) => ({
        name: s.name, title: s.title ?? s.name, lifecycle: s.publishing ? "publishing" : "operational", localized: s.localized === true, translates: s.translates ?? null,
        schema: s.schema, checks: (s.checks ?? []).map(sqlLogic), uniqueIndexes: s.unique ?? [], indexes: s.indexes ?? [], searchableFields: s.search ?? [], manifest: (({ checks: _ir, ...rest }) => rest)(s),
      })),
      views: views.map(([name, v]) => ({
        name, title: v.title ?? null, surface: v.surface, query: { kind: "sql" as const, statement: v.source, ...(v.input ? { params: v.input } : {}) },
        authorization: v.requires?.auth?.all ?? [], guard: null, manifest: (({ stmts: _ir, ...rest }) => rest)(v),
      })),
    },
    logic: { triggers, procedures },
    interfaces: { http, callable },
    graph: {
      atoms: [
        ...schemas.map((s) => ({ id: `Schema:${s.name}`, kind: "Schema" as const, name: s.name, title: s.title ?? s.name })),
        ...views.map(([name, v]) => ({ id: `View:${name}`, kind: "View" as const, name, title: v.title ?? null, audience: viewAudience(v) })),
        ...procedures.map(({ name, title, description, audience, handler, input }) => ({ id: `Procedure:${name}`, kind: "Procedure" as const, name, title, description, audience, handler, input })),
        ...triggers.map(({ name, source, audience }) => ({ id: `Trigger:${name}`, kind: "Trigger" as const, name, title: null, audience, transport: source.kind })),
      ].sort((a, b) => a.id.localeCompare(b.id)),
      relations,
    },
    operations: {
      // Admin's wire shape keeps the field; a plan declares no schedule (the application owns scheduled()).
      schedules: [],
      ttlPolicies: schemas.filter((s) => s.ttl).map((s) => ({ schema: s.name, field: s.names[s.ttl!] ?? s.ttl!, expireAfterSeconds: s.ttlSeconds ?? 0, sweepObservation: "unavailable" })),
      observationAvailability: "unavailable", runs: [], latestRuns: [],
    },
  };
}
