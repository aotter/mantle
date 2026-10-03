/**
 * The Developer console's snapshot (`GET {base}/api/developer-console`), derived from the plan alone: the data model, the logic, the
 * interfaces a caller reaches and the graph between them. Views and inline Procedures show their SQL as authored; the graph reads the
 * IR, so a View's sources and a Procedure's writes are the relations the runtime runs. No run is observed (G7).
 */
import { mcpTools, resolveMantleRef, type AuthPredicate, type AuthorizationRequirements, type JsonSchema, type RuntimePlan, type SqlNode } from "../spec/domain/index.js";
import { procedureFlow } from "./procedureFlow.js";

type Audience = "public" | "members" | "staff" | "system" | "api-clients";

/** Who a `requires` admits, as the console groups it; null is anyone. */
function audienceOf(requires: AuthorizationRequirements | undefined): Audience | null {
  const all: readonly AuthPredicate[] = requires?.auth?.all ?? [];
  if (all.some((p) => typeof p === "object" && "ctx.staff" in p)) return "staff";
  if (all.includes("ctx.user")) return "members";
  if (all.some((p) => p === "ctx.auth" || (typeof p === "object" && "ctx.auth.scope" in p))) return "api-clients";
  return null;
}

/** The Schemas a program reads (every table relation) and writes (a statement's target), by the plan's lower-case key. */
function relationsOf(stmts: readonly SqlNode[]): { reads: Set<string>; writes: Set<string> } {
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
  for (const w of writes) reads.delete(w);
  return { reads, writes };
}

const pointer = (s: string) => s.replace(/~/g, "~0").replace(/\//g, "~1");

export function developerConsole(plan: RuntimePlan) {
  const schemaName = (key: string) => plan.schemas[key]?.name;
  const schemas = Object.values(plan.schemas).sort((a, b) => a.name.localeCompare(b.name));
  const views = Object.entries(plan.views).filter(([, v]) => v.surface !== "internal").sort(([a], [b]) => a.localeCompare(b));
  const procedureAudience = (name: string): Audience => audienceOf(plan.procedures[name]?.requires) ?? "public";
  const handlerOf = (h: RuntimePlan["procedures"][string]["handler"]) => {
    if ("ref" in h) return { kind: "ref" as const, ref: h.ref };
    const flow = procedureFlow(h.sql.stmts, relationsOf);
    const verbs: Record<string, string> = { INSERT: "create", UPDATE: "update", DELETE: "delete" };
    const hooks = Object.entries(plan.triggers).flatMap(([trigger, t]) => {
      if (t.source.kind !== "lifecycle") return [];
      const source = t.source;
      const on = source.on.filter((hook) => flow.some((s) => s.writes.includes(source.schema.toLowerCase()) && hook.endsWith(`_${verbs[s.operation]}`)));
      return on.length ? [{ trigger, procedure: t.procedure, schema: source.schema, on }] : [];
    });
    return { kind: "sql" as const, statement: h.source, flow, hooks };
  };
  const procedures = Object.entries(plan.procedures).sort(([a], [b]) => a.localeCompare(b)).map(([name, p]) => ({
    name, title: p.title ?? null, description: p.description ?? null, audience: procedureAudience(name), input: p.input, output: p.output,
    authorization: p.requires?.auth?.all ?? [], guard: p.requires?.guard?.procedure ?? null, handler: handlerOf(p.handler),
    manifest: { ...p, handler: "ref" in p.handler ? p.handler : { source: p.handler.source } },
  }));
  const triggers = Object.entries(plan.triggers).sort(([a], [b]) => a.localeCompare(b)).map(([name, t]) => ({
    name, target: t.procedure, source: t.source, manifest: t,
    audience: (t.source.kind === "lifecycle" || t.source.kind === "schedule" ? "system" : t.source.kind === "mcp" && t.source.surface === "staff" ? "staff" : procedureAudience(t.procedure)) as Audience,
  }));
  const viewAudience = (v: RuntimePlan["views"][string]): Audience => (v.surface === "staff" ? "staff" : audienceOf(v.requires) ?? "public");

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
      ...(v.requires?.guard ? [relation(`View:${name}:guard:${v.requires.guard.procedure}`, "authorization-guard", `View:${name}`, `Procedure:${v.requires.guard.procedure}`, "/spec/requires/guard/procedure", v.requires.guard.procedure)] : []),
    ]),
    ...Object.entries(plan.procedures).flatMap(([name, p]) => [
      // what the Procedure writes: its SQL's targets, or the target a `ref` handler declares
      ...("sql" in p.handler ? [...relationsOf(p.handler.sql.stmts).writes].map(schemaName) : [p.target && schemaName(p.target.schema.toLowerCase())]).flatMap((s) => (s ? [relation(`Procedure:${name}:writes:${s}`, "procedure-schema", `Procedure:${name}`, `Schema:${s}`, "sql" in p.handler ? "/spec/handler/sql" : "/spec/target/schema", s)] : [])),
      ...(p.requires?.guard ? [relation(`Procedure:${name}:guard:${p.requires.guard.procedure}`, "authorization-guard", `Procedure:${name}`, `Procedure:${p.requires.guard.procedure}`, "/spec/requires/guard/procedure", p.requires.guard.procedure)] : []),
    ]),
    ...Object.entries(plan.triggers).flatMap(([name, t]) => [
      relation(`Trigger:${name}:target:${t.procedure}`, "trigger-target", `Trigger:${name}`, `Procedure:${t.procedure}`, "/spec/target/procedure", t.procedure),
      ...(t.source.kind === "lifecycle" && schemaName(t.source.schema.toLowerCase()) ? [relation(`Trigger:${name}:source:${t.source.schema}`, "lifecycle-source", `Trigger:${name}`, `Schema:${schemaName(t.source.schema.toLowerCase())}`, "/spec/source/schema", t.source.schema)] : []),
    ]),
  ].sort((a, b) => a.id.localeCompare(b.id));

  const callable = (["public", "staff"] as const).flatMap((surface) => mcpTools(plan, surface).map((tool) => ({
    kind: tool.kind, name: tool.name, target: tool.source, surface, audience: surface === "staff" ? "staff" : audienceOf(tool.requires) ?? "public",
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
        schema: s.schema, uniqueIndexes: s.unique ?? [], indexes: s.indexes ?? [], searchableFields: s.search ?? [], manifest: (({ checks: _ir, ...rest }) => rest)(s),
      })),
      views: views.map(([name, v]) => ({
        name, title: v.title ?? null, surface: v.surface, query: { kind: "sql" as const, statement: v.source, ...(v.input ? { params: v.input } : {}) },
        authorization: v.requires?.auth?.all ?? [], guard: v.requires?.guard?.procedure ?? null, manifest: (({ stmts: _ir, ...rest }) => rest)(v),
      })),
    },
    logic: { triggers, procedures },
    interfaces: { http, callable },
    graph: {
      atoms: [
        ...schemas.map((s) => ({ id: `Schema:${s.name}`, kind: "Schema" as const, name: s.name, title: s.title ?? s.name })),
        ...views.map(([name, v]) => ({ id: `View:${name}`, kind: "View" as const, name, title: v.title ?? null, audience: viewAudience(v) })),
        ...procedures.map(({ name, title, description, audience, handler }) => ({ id: `Procedure:${name}`, kind: "Procedure" as const, name, title, description, audience, handler })),
        ...triggers.map(({ name, source, audience }) => ({ id: `Trigger:${name}`, kind: "Trigger" as const, name, title: null, audience, transport: source.kind })),
      ].sort((a, b) => a.id.localeCompare(b.id)),
      relations,
    },
    operations: {
      schedules: Object.entries(plan.triggers).flatMap(([id, { procedure, source }]) => (source.kind === "schedule" ? [{ id, procedure, cron: source.cron, enabled: source.enabled ?? true, registration: "not-observed" }] : [])),
      ttlPolicies: schemas.filter((s) => s.ttl).map((s) => ({ schema: s.name, field: s.names[s.ttl!] ?? s.ttl!, expireAfterSeconds: s.ttlSeconds ?? 0, sweepObservation: "unavailable" })),
      observationAvailability: "unavailable", runs: [], latestRuns: [],
    },
  };
}
