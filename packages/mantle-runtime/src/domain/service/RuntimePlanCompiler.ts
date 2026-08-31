import {
  MCP_CREATE_DRAFT_PREFIX,
  MCP_CREATE_RECORD_PREFIX,
  MCP_QUERY_VIEW_PREFIX,
  MCP_UPDATE_DRAFT_PREFIX,
  MCP_UPDATE_RECORD_PREFIX,
  mcpToolNameSegment,
  resolveLifecycle,
  type AuthPredicate,
  type FilterAst,
  type HttpMethod,
  type JsonSchema,
  type LifecycleHook,
  type LinkResult,
  type LinkedManifestSet,
  type ProcedureManifest,
  type SchemaManifest,
  type TriggerManifest,
  type ViewManifest,
} from "@aotter/mantle-spec";

export const RUNTIME_PLAN_VERSION = 1 as const;

export interface RuntimeSchemaPlan {
  readonly name: string;
  readonly manifest: SchemaManifest;
  readonly translationParent?: string;
}

export interface AuthorizationPlan {
  readonly all: readonly AuthPredicate[];
}

export interface RuntimeProcedurePlan {
  readonly name: string;
  readonly manifest: ProcedureManifest;
  readonly authorization?: AuthorizationPlan;
  readonly guard?: string;
  readonly builtinSchema?: string;
  readonly collectionActionSchema?: string;
}

export type LogicalViewPlan =
  | {
      readonly kind: "declarative";
      readonly from: string;
      readonly fields?: readonly string[];
      readonly filter?: FilterAst;
      readonly orderBy: readonly {
        readonly field: string;
        readonly direction: "asc" | "desc";
      }[];
      readonly limit?: number;
      readonly params?: JsonSchema;
    }
  | {
      readonly kind: "native";
      readonly dialect: "sqlite";
      readonly statement: string;
      readonly limit?: number;
      readonly params?: JsonSchema;
    };

export interface RuntimeViewPlan {
  readonly name: string;
  readonly manifest: ViewManifest;
  readonly query: LogicalViewPlan;
  readonly authorization?: AuthorizationPlan;
  readonly guard?: string;
}

export interface RuntimeTriggerPlan {
  readonly name: string;
  readonly manifest: TriggerManifest;
  readonly target: string;
  readonly lifecycleSchema?: string;
}

export interface LifecycleHookPlan {
  readonly schema: string;
  readonly hook: LifecycleHook;
  readonly triggerNames: readonly string[];
}

export interface HttpRoutePlan {
  readonly trigger: string;
  readonly method: HttpMethod;
  readonly path: string;
  readonly procedure: string;
}

interface McpToolPlanBase {
  readonly name: string;
  readonly ownerName: string;
  readonly surface: "staff" | "public";
}

export type McpToolPlan = McpToolPlanBase & (
  | { readonly ownerKind: "Schema" | "View" }
  | { readonly ownerKind: "Procedure"; readonly trigger: string }
);

declare const runtimePlanBrand: unique symbol;

export interface RuntimePlanData {
  readonly version: typeof RUNTIME_PLAN_VERSION;
  readonly semanticFingerprint: string;
  readonly schemas: Readonly<Record<string, RuntimeSchemaPlan>>;
  readonly views: Readonly<Record<string, RuntimeViewPlan>>;
  readonly procedures: Readonly<Record<string, RuntimeProcedurePlan>>;
  readonly triggers: Readonly<Record<string, RuntimeTriggerPlan>>;
  readonly lifecycleHooks: readonly LifecycleHookPlan[];
  readonly httpRoutes: readonly HttpRoutePlan[];
  readonly mcpTools: readonly McpToolPlan[];
}

export interface RuntimePlan extends RuntimePlanData {
  readonly [runtimePlanBrand]: true;
}

export type CompileResult<T> = LinkResult<T>;

/** Pure projection from sealed semantics to the adapter-neutral runtime contract. */
export function compileRuntimePlan(
  linked: LinkedManifestSet,
): CompileResult<RuntimePlan> {
  const schemas = toRecord(linked.schemas.map(({ manifest, translationParent }) => {
    const copy = canonicalClone(manifest);
    return {
      name: copy.metadata.name,
      manifest: copy,
      ...(translationParent
        ? { translationParent: translationParent.manifest.metadata.name }
        : {}),
    };
  }));
  const procedures = toRecord(linked.procedures.map((procedure) => {
    const manifest = canonicalClone(procedure.manifest);
    return {
      name: manifest.metadata.name,
      manifest,
      ...authorization(manifest.spec.requires?.auth?.all),
      ...(procedure.guard ? { guard: procedure.guard.manifest.metadata.name } : {}),
      ...(procedure.builtinSchema
        ? { builtinSchema: procedure.builtinSchema.manifest.metadata.name }
        : {}),
      ...(procedure.collectionActionSchema
        ? { collectionActionSchema: procedure.collectionActionSchema.manifest.metadata.name }
        : {}),
    };
  }));
  const views = toRecord(linked.views.map((view) => {
    const manifest = canonicalClone(view.manifest);
    return {
      name: manifest.metadata.name,
      manifest,
      query: compileLogicalView(manifest),
      ...authorization(manifest.spec.requires?.auth?.all),
      ...(view.guard ? { guard: view.guard.manifest.metadata.name } : {}),
    };
  }));
  const triggers = toRecord(linked.triggers.map((trigger) => {
    const manifest = canonicalClone(trigger.manifest);
    return {
      name: manifest.metadata.name,
      manifest,
      target: trigger.target.manifest.metadata.name,
      ...(trigger.lifecycleSchema
        ? { lifecycleSchema: trigger.lifecycleSchema.manifest.metadata.name }
        : {}),
    };
  }));
  const lifecycleHooks = compileLifecycleHooks(Object.values(triggers));
  const httpRoutes = Object.values(triggers)
    .flatMap((trigger): HttpRoutePlan[] => trigger.manifest.spec.source.kind === "http"
      ? [{
          trigger: trigger.name,
          method: trigger.manifest.spec.source.method,
          path: trigger.manifest.spec.source.path,
          procedure: trigger.target,
        }]
      : [])
    .sort((a, b) => compareText(`${a.method} ${a.path}`, `${b.method} ${b.path}`));
  const mcpTools = compileMcpTools(schemas, views, triggers);
  const semantics = {
    version: RUNTIME_PLAN_VERSION,
    schemas,
    views,
    procedures,
    triggers,
    lifecycleHooks,
    httpRoutes,
    mcpTools,
  };
  return {
    ok: true,
    value: sealRuntimePlan({
      ...semantics,
      semanticFingerprint: semanticFingerprint(semantics),
    }),
    diagnostics: [],
  };
}

/** Restore the brand and immutability of a generated, JSON-safe plan. */
export function sealRuntimePlan(data: RuntimePlanData): RuntimePlan {
  const copy = canonicalClone(data);
  const { semanticFingerprint: declared, ...semantics } = copy;
  if (copy.version !== RUNTIME_PLAN_VERSION || semanticFingerprint(semantics) !== declared) {
    throw new Error("Generated RuntimePlan fingerprint is invalid; run `mantle generate` again.");
  }
  return deepFreeze(copy) as RuntimePlan;
}

export function compileLogicalView(view: ViewManifest): LogicalViewPlan {
  if (view.spec.sql) {
    return {
      kind: "native",
      dialect: "sqlite",
      statement: view.spec.sql,
      ...(view.spec.limit === undefined ? {} : { limit: view.spec.limit }),
      ...(view.spec.params === undefined ? {} : { params: view.spec.params }),
    };
  }
  return {
    kind: "declarative",
    from: view.spec.from!,
    ...(view.spec.fields === undefined ? {} : { fields: view.spec.fields }),
    ...(view.spec.filter === undefined ? {} : { filter: view.spec.filter }),
    orderBy: (view.spec.orderBy ?? []).map((order) => ({
      field: order.field,
      direction: order.direction ?? "asc",
    })),
    ...(view.spec.limit === undefined ? {} : { limit: view.spec.limit }),
    ...(view.spec.params === undefined ? {} : { params: view.spec.params }),
  };
}

function authorization(all: readonly AuthPredicate[] | undefined): {
  readonly authorization?: AuthorizationPlan;
} {
  return all && all.length > 0 ? { authorization: { all } } : {};
}

function compileLifecycleHooks(
  triggers: readonly RuntimeTriggerPlan[],
): readonly LifecycleHookPlan[] {
  const groups = new Map<string, { schema: string; hook: LifecycleHook; names: string[] }>();
  for (const trigger of triggers) {
    const source = trigger.manifest.spec.source;
    if (source.kind !== "lifecycle") continue;
    for (const hook of source.on) {
      const key = `${source.schema}\0${hook}`;
      const group = groups.get(key) ?? { schema: source.schema, hook, names: [] };
      group.names.push(trigger.name);
      groups.set(key, group);
    }
  }
  return [...groups.values()]
    .sort((a, b) => compareText(`${a.schema}\0${a.hook}`, `${b.schema}\0${b.hook}`))
    .map(({ schema, hook, names }) => ({
      schema,
      hook,
      triggerNames: names.sort(compareText),
    }));
}

function compileMcpTools(
  schemas: Readonly<Record<string, RuntimeSchemaPlan>>,
  views: Readonly<Record<string, RuntimeViewPlan>>,
  triggers: Readonly<Record<string, RuntimeTriggerPlan>>,
): readonly McpToolPlan[] {
  const tools: McpToolPlan[] = [];
  for (const schema of Object.values(schemas)) {
    if (schema.manifest.spec.schema.readOnly === true) continue;
    const segment = mcpToolNameSegment(schema.name);
    const operational = resolveLifecycle(schema.manifest) === "operational";
    tools.push(
      {
        name: `${operational ? MCP_CREATE_RECORD_PREFIX : MCP_CREATE_DRAFT_PREFIX}${segment}`,
        ownerKind: "Schema",
        ownerName: schema.name,
        surface: "staff",
      },
      {
        name: `${operational ? MCP_UPDATE_RECORD_PREFIX : MCP_UPDATE_DRAFT_PREFIX}${segment}`,
        ownerKind: "Schema",
        ownerName: schema.name,
        surface: "staff",
      },
    );
  }
  for (const view of Object.values(views)) {
    tools.push({
      name: `${MCP_QUERY_VIEW_PREFIX}${mcpToolNameSegment(view.name)}`,
      ownerKind: "View",
      ownerName: view.name,
      surface: view.manifest.spec.surface,
    });
  }
  for (const trigger of Object.values(triggers)) {
    const source = trigger.manifest.spec.source;
    if (source.kind !== "mcp") continue;
    tools.push({
      name: mcpToolNameSegment(trigger.target),
      ownerKind: "Procedure",
      ownerName: trigger.target,
      surface: source.surface,
      trigger: trigger.name,
    });
  }
  return [...new Map(tools.map((tool) => [`${tool.surface}\0${tool.name}`, tool])).values()]
    .sort((a, b) =>
      compareText(
        `${a.surface}\0${a.name}\0${a.ownerName}`,
        `${b.surface}\0${b.name}\0${b.ownerName}`,
      )
    );
}

function toRecord<T extends { readonly name: string }>(
  values: readonly T[],
): Readonly<Record<string, T>> {
  const record = Object.create(null) as Record<string, T>;
  for (const value of [...values].sort((a, b) => compareText(a.name, b.name))) {
    record[value.name] = value;
  }
  return record;
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function canonicalClone<T>(value: T): T {
  if (Array.isArray(value)) return value.map(canonicalClone) as T;
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => [key, canonicalClone(record[key])]),
  ) as T;
}

function semanticFingerprint(value: unknown): string {
  const json = canonicalJson(value);
  let hash = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(json)) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  // ponytail: non-security cache identity; switch to async SHA-256 if fingerprints cross a trust boundary.
  return `fnv1a64:${hash.toString(16).padStart(16, "0")}`;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort();
    return `{${keys.map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(record[key])}`
    ).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return value;
}
