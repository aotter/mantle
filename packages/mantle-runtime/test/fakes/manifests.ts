import type {
  LifecycleHook,
  ProcedureManifest,
  SchemaManifest,
  TriggerManifest,
  ViewManifest,
} from "@aotter/mantle-spec";

/**
 * Hand-built manifests for tests. Mirrors the shape `parseManifests`
 * would produce; lets tests assemble Schemas / Procedures / Triggers
 * / Views without parsing YAML.
 */
export function postsSchema(): SchemaManifest {
  return {
    apiVersion: "cms.mantle.aotter.net/v1",
    kind: "Schema",
    metadata: { name: "posts" },
    spec: {
      title: "Posts",
      schema: {
        type: "object",
        properties: {
          title: { type: "string" },
          slug: { type: "string" },
          coverUrl: { type: "string", format: "uri", "x-mcp-hint": "media-image" },
          content: { type: "string" },
        },
        required: ["title"],
      },
      lifecycle: "simple",
    },
  };
}

export function recentPostsView(): ViewManifest {
  return {
    apiVersion: "cms.mantle.aotter.net/v1",
    kind: "View",
    metadata: { name: "recent-posts" },
    spec: {
      from: "posts",
      filter: { eq: { field: "status", value: "published" } },
      orderBy: [{ field: "updatedAt", direction: "desc" }],
      limit: 10,
    },
  };
}

export interface ProcedureOpts {
  readonly name?: string;
  readonly handlerRef?: string;
  /** Override the entire `handler` discriminated union — use to build
   *  `handler.kind: 'builtin'` Procedures. When unset, defaults to
   *  `{ kind: 'ref', ref: handlerRef ?? 'echoHandler' }`. */
  readonly handler?: ProcedureManifest["spec"]["handler"];
  readonly input?: SchemaManifest["spec"]["schema"];
  readonly output?: SchemaManifest["spec"]["schema"];
  readonly authPredicates?: ProcedureManifest["spec"]["requires"]["auth"]["all"] extends infer A
    ? A
    : never;
  readonly guard?: string;
}

export function makeProcedure(opts: ProcedureOpts = {}): ProcedureManifest {
  const proc: ProcedureManifest = {
    apiVersion: "cms.mantle.aotter.net/v1",
    kind: "Procedure",
    metadata: { name: opts.name ?? "echo" },
    spec: {
      input: opts.input ?? {
        type: "object",
        properties: { msg: { type: "string" } },
        required: ["msg"],
      },
      output: opts.output ?? {
        type: "object",
        properties: { ok: { type: "boolean" } },
        required: ["ok"],
      },
      handler: opts.handler ?? { kind: "ref", ref: opts.handlerRef ?? "echoHandler" },
    },
  };
  if (opts.authPredicates || opts.guard) {
    return {
      ...proc,
      spec: {
        ...proc.spec,
        requires: {
          ...(opts.authPredicates ? { auth: { all: opts.authPredicates } } : {}),
          ...(opts.guard ? { guard: { procedure: opts.guard } } : {}),
        },
      },
    };
  }
  return proc;
}

export function makeHttpTrigger(opts: {
  readonly name?: string;
  readonly procedure: string;
  readonly path?: string;
  readonly method?: "POST" | "PUT" | "PATCH" | "DELETE";
}): TriggerManifest {
  return {
    apiVersion: "cms.mantle.aotter.net/v1",
    kind: "Trigger",
    metadata: { name: opts.name ?? `${opts.procedure}-trigger` },
    spec: {
      source: {
        kind: "http",
        method: opts.method ?? "POST",
        path: opts.path ?? `/api/${opts.procedure}`,
      },
      target: { procedure: opts.procedure },
    },
  };
}

export function makeLifecycleTrigger(opts: {
  readonly name?: string;
  readonly procedure: string;
  readonly schema?: string;
  readonly on?: ReadonlyArray<LifecycleHook>;
  readonly errorPolicy?: "abort" | "continue";
}): TriggerManifest {
  return {
    apiVersion: "cms.mantle.aotter.net/v1",
    kind: "Trigger",
    metadata: { name: opts.name ?? `${opts.procedure}-${opts.on?.[0] ?? "lifecycle"}-trigger` },
    spec: {
      source: {
        kind: "lifecycle",
        schema: opts.schema ?? "posts",
        on: opts.on ?? ["before_create"],
        ...(opts.errorPolicy ? { errorPolicy: opts.errorPolicy } : {}),
      },
      target: { procedure: opts.procedure },
    },
  };
}

export function makeMcpTrigger(opts: {
  readonly name?: string;
  readonly procedure: string;
  readonly surface?: "staff" | "public";
}): TriggerManifest {
  return {
    apiVersion: "cms.mantle.aotter.net/v1",
    kind: "Trigger",
    metadata: { name: opts.name ?? `${opts.procedure}-mcp` },
    spec: {
      source: { kind: "mcp", surface: opts.surface ?? "staff" },
      target: { procedure: opts.procedure },
    },
  };
}

export function makeBuiltinProcedure(opts: {
  readonly name?: string;
  readonly schema?: string;
  readonly op?: "create" | "update" | "upsert" | "delete";
}): ProcedureManifest {
  return makeProcedure({
    name: opts.name ?? "create-post",
    input: { type: "object", properties: { data: { type: "object" } } },
    output: { type: "object" },
    handler: { kind: "builtin", op: opts.op ?? "create", schema: opts.schema ?? "posts" },
  });
}
