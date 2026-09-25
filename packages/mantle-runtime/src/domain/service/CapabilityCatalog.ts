import {
  MANTLE_BIND_KEYWORD,
  MCP_CREATE_DRAFT_PREFIX,
  MCP_CREATE_RECORD_PREFIX,
  MCP_UPDATE_DRAFT_PREFIX,
  MCP_UPDATE_RECORD_PREFIX,
  expandPolicyRequired,
  mcpToolNameSegment,
  resolveLifecycle,
  resolveLocalizedText,
  schemaSortableFields,
  type JsonSchema,
  type MediaPurposePolicy,
  type SchemaManifest,
  type StaffRole,
  type ViewManifest,
} from "@aotter/mantle-spec";
import type {
  ProcedureCallableCapability,
  RuntimeCallableCapability,
  ViewCallableCapability,
  ViewRowAction,
} from "./CallableCapabilityProjector.js";
import { projectStandardOutputSchema } from "./StandardOutputSchema.js";

/**
 * Transport-neutral catalog of everything a caller can invoke on one
 * surface: the sealed plan's Views and Procedures, plus the generic
 * authoring, lifecycle and media operations derived from Schemas.
 *
 * A transport (MCP today) only renames fields for its wire. Semantics that
 * must not change with the transport live here or in
 * `InvokeCapabilityUseCase`: role floors, argument shapes, descriptions and
 * the observed-version contract.
 */
export type CapabilitySurface = "staff" | "public";

/** Behavioral hints. Only provable or author-declared values are set; an
 *  absent hint means "unknown", never "false" (#972). */
export interface CapabilityHints {
  readonly readOnly?: boolean;
  readonly destructive?: boolean;
  readonly idempotent?: boolean;
  readonly openWorld?: boolean;
}

export type LifecycleAction = "requestPublish" | "unpublish" | "archive" | "delete";

/** Where an invocation goes. Resolved once here so invocation never parses
 *  capability names. */
export type CapabilityRoute =
  | { readonly kind: "view"; readonly view: ViewManifest }
  | { readonly kind: "procedure"; readonly trigger: string }
  | { readonly kind: "lifecycle"; readonly action: LifecycleAction }
  | { readonly kind: "create"; readonly collection: string }
  | { readonly kind: "update"; readonly collection: string }
  | { readonly kind: "read" }
  | { readonly kind: "mediaCreateUpload" }
  | { readonly kind: "mediaCommitUpload" };

export interface Capability {
  readonly name: string;
  readonly surface: CapabilitySurface;
  readonly title?: string;
  readonly description: string;
  /** Advertised input contract, with localized annotations collapsed. */
  readonly inputSchema: Record<string, unknown>;
  /** Standard JSON Schema for structured results, present only when every
   *  output Runtime accepts also passes a standard validator
   *  (`projectStandardOutputSchema`). */
  readonly outputSchema?: Record<string, unknown>;
  readonly hints?: CapabilityHints;
  /** Staff role floor checked before any argument is read. */
  readonly minimumRole?: StaffRole;
  /** True when an anonymous caller can never succeed, so a transport may
   *  challenge for credentials before invoking. Dynamic guards may still
   *  deny an identified caller at call time. */
  readonly requiresIdentity: boolean;
  /** OAuth scopes the declared `ctx.auth.scope` predicates require, so a
   *  transport can ask for them before invoking. Empty when none. */
  readonly requiredScopes: readonly string[];
  /** Argument that correlates retries of one operation in audit trails. */
  readonly operationIdArgument: string;
  readonly route: CapabilityRoute;
  /** For a View: operations a row can open, with the fields they bind. */
  readonly rowActions?: readonly ViewRowAction[];
}

export interface CapabilityCatalog {
  readonly surface: CapabilitySurface;
  readonly capabilities: readonly Capability[];
  get(name: string): Capability | undefined;
}

export interface BuildCapabilityCatalogOptions {
  readonly surface?: CapabilitySurface;
  /** Sealed-plan callable projection (`projectCallableCapabilities`). */
  readonly callables?: readonly RuntimeCallableCapability[];
  /** Declared media purposes. Media operations exist only when this is set,
   *  which callers do when the runtime has media storage bound. */
  readonly mediaPurposes?: readonly MediaPurposePolicy[];
  /** Schemas that are the subject of a declared interaction. Staff surfaces
   *  get a bounded single-entry read for exactly these (ADR-0029 D2). */
  readonly readTargets?: readonly string[];
}

export function buildCapabilityCatalog(
  schemas: ReadonlyArray<SchemaManifest>,
  options: BuildCapabilityCatalogOptions = {},
): CapabilityCatalog {
  const surface = options.surface ?? "staff";
  const callables = (options.callables ?? [])
    .filter((item) => item.surface === surface)
    .map((item) => callableCapability(item));
  const readTargets = (options.readTargets ?? []).filter((name) => schemas.some((schema) => schema.metadata.name === name));
  const drafts = surface === "public" ? callables : [
    ...lifecycleCapabilities(schemas),
    ...(readTargets.length > 0 ? [readCapability(readTargets)] : []),
    ...(options.mediaPurposes ? mediaCapabilities(options.mediaPurposes) : []),
    ...schemas
      .filter((schema) => schema.spec.schema.readOnly !== true)
      .flatMap((schema) => [createCapability(schema), updateCapability(schema)]),
    ...callables,
  ];
  const capabilities = Object.freeze(drafts.map((draft) => finish(draft, surface)));
  const byName = new Map(capabilities.map((capability) => [capability.name, capability]));
  return Object.freeze({ surface, capabilities, get: (name: string) => byName.get(name) });
}

type CapabilityDraft = Omit<Capability, "surface" | "requiresIdentity" | "requiredScopes" | "operationIdArgument"> & {
  readonly anonymousDenied?: boolean;
  readonly requiredScopes?: readonly string[];
};

function finish(draft: CapabilityDraft, surface: CapabilitySurface): Capability {
  const { anonymousDenied, outputSchema, route, requiredScopes, ...rest } = draft;
  const inputSchema = frozenCopy(collapseSchemaAnnotations(rest.inputSchema));
  return Object.freeze({
    ...rest,
    ...(rest.hints ? { hints: frozenCopy(rest.hints) } : {}),
    ...(outputSchema ? { outputSchema: frozenCopy(outputSchema) } : {}),
    // A View route carries the sealed plan's manifest, which stays shared.
    route: Object.freeze({ ...route }),
    surface,
    inputSchema,
    // Staff surfaces admit only verified staff, so every staff capability
    // needs an identity; public ones need one only when they declare it.
    requiresIdentity: surface === "staff" || anonymousDenied === true,
    requiredScopes: Object.freeze([...(requiredScopes ?? [])]),
    operationIdArgument: idempotencyKeys(inputSchema)[0] ?? "operationId",
  });
}

const ENTRY_TARGET_SCHEMA = {
  type: "object",
  properties: { collection: { type: "string" }, id: { type: "string" } },
  required: ["collection", "id"],
};

const LIFECYCLE_OPERATIONS: ReadonlyArray<{
  readonly name: string;
  readonly action: LifecycleAction;
  readonly description: string;
  readonly hints: CapabilityHints;
}> = [
  {
    name: "request_publish",
    action: "requestPublish",
    description: "Publish a draft immediately. Not available for operational records.",
    hints: { readOnly: false },
  },
  {
    name: "unpublish_entry",
    action: "unpublish",
    description: "Unpublish a content entry back to draft before editing. Not available for operational records.",
    hints: { readOnly: false },
  },
  {
    name: "archive_entry",
    action: "archive",
    description: "Archive a content entry. Not available for operational records.",
    hints: { readOnly: false },
  },
  {
    name: "delete_entry",
    action: "delete",
    description: "Permanently delete an entry. For content lifecycles, prefer archive_entry when reversibility matters.",
    hints: { readOnly: false, destructive: true },
  },
];

/**
 * One entry by id, for the collections an interaction is about. A staff
 * snapshot read is bounded to those so a model provider's context only ever
 * receives records someone declared an operation for.
 */
function readCapability(collections: readonly string[]): CapabilityDraft {
  const sorted = [...collections].sort();
  return {
    name: "read_entry",
    description: `Read one entry by id, including its version, to review it before an operation. Collections: ${sorted.join(", ")}.`,
    inputSchema: {
      type: "object",
      properties: { collection: { type: "string", enum: sorted }, id: { type: "string" } },
      required: ["collection", "id"],
    },
    hints: { readOnly: true },
    minimumRole: "contributor",
    route: { kind: "read" },
  };
}

/** Lifecycle actions that need a content (publishing) lifecycle. */
export const CONTENT_LIFECYCLE_ACTIONS: ReadonlySet<LifecycleAction> = new Set([
  "requestPublish",
  "unpublish",
  "archive",
]);

function lifecycleCapabilities(schemas: ReadonlyArray<SchemaManifest>): CapabilityDraft[] {
  const writable = schemas.filter((s) => s.spec.schema.readOnly !== true);
  const content = writable.filter((s) => resolveLifecycle(s) !== "operational");
  return LIFECYCLE_OPERATIONS.flatMap((operation) => {
    const targets = CONTENT_LIFECYCLE_ACTIONS.has(operation.action) ? content
      : operation.action === "delete" ? writable : schemas;
    if (targets.length === 0) return [];
    const summary = targets.map((s) =>
      `${s.metadata.name} (${resolveLifecycle(s)}${s.spec.schema.readOnly ? "; Procedure-only writes" : ""}; search: ${["id", ...(s.spec.searchableFields ?? [])].join(", ")}; sort: ${["id", "status", "updatedAt", ...schemaSortableFields(s)].join(", ")})`,
    ).join("; ");
    return [{
      name: operation.name,
      description: `${operation.description} Collections: ${summary}. Prefer declared business Procedures and Views when available.`,
      inputSchema: ENTRY_TARGET_SCHEMA,
      hints: operation.hints,
      minimumRole: "editor",
      route: { kind: "lifecycle", action: operation.action },
    }];
  });
}

function mediaCapabilities(mediaPurposes: readonly MediaPurposePolicy[]): CapabilityDraft[] {
  return [createMediaUploadCapability(mediaPurposes), COMMIT_MEDIA_UPLOAD];
}

const COMMIT_MEDIA_UPLOAD: CapabilityDraft = {
  name: "commit_media_upload",
  description:
    "Commit a previously-PUT variant bundle. Verifies every variant landed at the storage backend (HEAD + bytes per declared mime) and writes the committed MediaAsset to the media_assets table. Returns the asset with its variants populated; write the returned MediaAsset.id into the relevant media asset id field via the authoring tools. Only registered when the runtime has a media storage adapter bound and a media.purposes taxonomy declared.",
  inputSchema: {
    type: "object",
    properties: {
      uploadGroupId: {
        type: "string",
        description:
          "Logical asset id returned by create_media_upload as `uploadGroupId`; passed verbatim to commit.",
      },
      alt: { type: "string" },
      caption: { type: "string" },
    },
    required: ["uploadGroupId"],
  },
  hints: { readOnly: false },
  minimumRole: "editor",
  route: { kind: "mediaCommitUpload" },
};

function createMediaUploadCapability(mediaPurposes: readonly MediaPurposePolicy[]): CapabilityDraft {
  const purpose: Record<string, unknown> = {
    type: "string",
    description:
      "Required purpose tag declared by this starter. Determines the required variant mime set + per-mime byte caps.",
  };
  if (mediaPurposes.length > 0) purpose["enum"] = mediaPurposes.map((p) => p.name);

  const policySummary =
    mediaPurposes.length > 0
      ? "Purpose policies in this deployment:\n" +
        mediaPurposes
          .map((p) => {
            const slots = expandPolicyRequired(p.required)
              .map(
                (mimes, i) =>
                  `slot ${i}: ${
                    mimes.length > 1
                      ? `one of [${mimes.join(", ")}]`
                      : mimes[0]
                  }`,
              )
              .join("; ");
            const caps = Object.entries(p.maxBytes)
              .map(([m, b]) => `${m}=${b}`)
              .join(", ");
            return `  • ${p.name} upload rules — ${slots}; choose exactly one mime per slot from this live policy; maxBytes: ${caps}`;
          })
          .join("\n")
      : "";

  return {
    name: "create_media_upload",
    description:
      "Issue short-lived PUT capabilities for every variant of one logical media asset. " +
      "If the user provides an image in chat or the current session, the MCP client/agent must handle it directly: read the attachment bytes in the agent runtime, prepare the required variants locally, call create_media_upload with the variant manifest and byte sizes, HTTP PUT each returned uploadUrl using requiredHeaders, then call commit_media_upload. Do not ask the user to open a terminal. Do not send image bytes through MCP; this server intentionally does not expose a base64 upload tool. " +
      "Multi-variant by default (#272): one call yields N upload URLs (one per declared slot); the host may use presigned R2 URLs or authenticated same-origin Worker routes. " +
      "Per-asset, the agent picks ONE mime per slot from that slot's acceptable set (#282); a " +
      "single purpose declared with slot 0 = `image/jpeg,image/png,image/gif` accepts jpeg photo primary, png alpha/logo primary, or gif primary when animation is preserved. The primary/fallback variant is not always JPEG. Do NOT default to JPEG just because it appears in the policy: read the upload rules below and choose the mime that preserves the source. " +
      "Preserve source semantics while preparing variants: opaque photos may use JPEG primary plus WebP/AVIF alternates; transparent PNG/logo artwork must keep alpha using PNG primary plus alpha-preserving WebP/AVIF; animated GIFs must stay animated in every generated variant. If the available processor would flatten animation or drop transparency, stop and report that limitation instead of uploading degraded media. maxBytes is a hard safety cap, not a web-performance target. If the source or prepared variants are obviously wasteful for website delivery, ask the user in chat before uploading whether to optimize/compress/resize for faster page loads while preserving alpha/animation semantics. " +
      "Optimization runs agent-side with whatever image processor the MCP client has available; prefer an already-installed dependency, otherwise install a standard image processing package in the agent workspace if the host permits package installs. Node agents should prefer sharp; Python agents should prefer Pillow. If the host supports reusable agent memory or skills, remember this media-variant workflow for reuse. If the current MCP host/runtime harness blocks HTTP PUT requests to the returned uploadUrl, tell the user this host cannot complete the media upload and suggest retrying from an agent/runtime that allows outbound HTTP file uploads; do not ask the user to run terminal upload commands. Send requiredHeaders and, for same-origin URLs, the authenticated session. The Worker enforces policy and may relay the bytes to storage. After uploading every variant, call commit_media_upload with the returned uploadGroupId. Only registered when the runtime " +
      "has a media storage adapter bound and a media.purposes taxonomy declared." +
      (policySummary ? `\n\n${policySummary}` : ""),
    inputSchema: {
      type: "object",
      properties: {
        filename: {
          type: "string",
          description:
            "Original filename — used in object metadata only; storage keys are server-generated.",
        },
        purpose,
        variants: {
          type: "array",
          minItems: 1,
          description:
            "One entry per format the agent has prepared. Must cover every slot in the purpose's `required` set. Read the dynamic upload rules in the tool description: if a slot lists alternatives like `image/jpeg,image/png,image/gif`, choose exactly one of them for this asset. Use JPEG only for opaque photos, PNG when alpha/transparency must be preserved, and GIF only when animation is preserved. Modern formats (avif/webp) MUST NOT exceed the fallback's byteSize — the runtime rejects suspicious sizing.",
          items: {
            type: "object",
            properties: {
              mimeType: {
                type: "string",
                description:
                  "Content-Type. Allowlist: image/png, image/jpeg, image/webp, image/gif, image/avif. SVG only with adapter opt-in.",
              },
              byteSize: {
                type: "number",
                description:
                  "Caller-declared payload size. Verified against the purpose's `maxBytes[mimeType]` before an upload URL is issued.",
              },
              role: {
                type: "string",
                enum: ["primary", "alternate", "fallback"],
                description:
                  "`primary` is the `<img>` fallback chosen from the purpose's live policy for this asset; it is not always JPEG. `alternate` is preferred via `<picture><source>` (avif/webp).",
              },
            },
            required: ["mimeType", "byteSize", "role"],
          },
        },
        alt: { type: "string" },
        caption: { type: "string" },
      },
      required: ["filename", "purpose", "variants"],
    },
    hints: { readOnly: false },
    minimumRole: "editor",
    route: { kind: "mediaCreateUpload" },
  };
}

/**
 * Per-collection authoring operations. Operational records use the
 * `*_record_*` names and need the editor role; content drafts use the
 * `*_draft_*` names and need contributor. Properties carrying
 * `x-mantle-bind` are server-stamped and never part of the input.
 */
function createCapability(schema: SchemaManifest): CapabilityDraft {
  const operational = resolveLifecycle(schema) === "operational";
  const { properties, required } = authoringFields(schema);
  const base = operational
    ? `Create a live operational record in '${schema.metadata.name}'.`
    : `Create a new draft entry in '${schema.metadata.name}'.`;
  return {
    name: `${operational ? MCP_CREATE_RECORD_PREFIX : MCP_CREATE_DRAFT_PREFIX}${mcpToolNameSegment(schema.metadata.name)}`,
    description: withSchemaDescription(base, schema),
    inputSchema: {
      type: "object",
      properties,
      ...(required.length > 0 ? { required } : {}),
    },
    hints: { readOnly: false },
    minimumRole: operational ? "editor" : "contributor",
    route: { kind: "create", collection: schema.metadata.name },
  };
}

function updateCapability(schema: SchemaManifest): CapabilityDraft {
  const operational = resolveLifecycle(schema) === "operational";
  const { properties, required } = authoringFields(schema);
  const occ =
    " Send expected_version as the observed native entry.version from read time, not version+1.";
  const base = operational
    ? `Update an operational record in '${schema.metadata.name}' with optimistic-concurrency check.${occ}`
    : `Update a draft entry in '${schema.metadata.name}' with optimistic-concurrency check.${occ}`;
  return {
    name: `${operational ? MCP_UPDATE_RECORD_PREFIX : MCP_UPDATE_DRAFT_PREFIX}${mcpToolNameSegment(schema.metadata.name)}`,
    description: withSchemaDescription(base, schema),
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Entry id to update." },
        expected_version: {
          type: "number",
          description:
            "Observed native entry.version at read time (not version+1). A successful write still bumps storage to this value + 1.",
        },
        ...properties,
      },
      required: ["id", "expected_version", ...required],
    },
    hints: { readOnly: false },
    minimumRole: operational ? "editor" : "contributor",
    route: { kind: "update", collection: schema.metadata.name },
  };
}

/** Top-level update arguments that address the entry rather than its data. */
export const UPDATE_ENVELOPE_ARGUMENTS: readonly string[] = ["id", "expected_version"];

function withSchemaDescription(base: string, schema: SchemaManifest): string {
  const description = resolveLocalizedText(schema.spec.description, "en");
  return description ? `${base} ${description}` : base;
}

function authoringFields(schema: SchemaManifest): {
  readonly properties: Record<string, unknown>;
  readonly required: readonly string[];
} {
  const props =
    (schema.spec.schema as { properties?: Record<string, unknown> }).properties ?? {};
  const originalRequired =
    (schema.spec.schema as { required?: readonly string[] }).required ?? [];
  const entries = Object.entries(props).filter(([, definition]) => !hasMantleBind(definition));
  return {
    properties: Object.fromEntries(entries),
    required: entries.map(([key]) => key).filter((key) => originalRequired.includes(key)),
  };
}

function hasMantleBind(definition: unknown): boolean {
  return isRecord(definition) && MANTLE_BIND_KEYWORD in definition;
}

function callableCapability(capability: RuntimeCallableCapability): CapabilityDraft {
  return capability.kind === "view" ? viewCapability(capability) : procedureCapability(capability);
}

function viewCapability(capability: ViewCallableCapability): CapabilityDraft {
  const requires = capability.manifest.spec.requires;
  return {
    name: capability.name,
    ...(capability.title ? { title: capability.title } : {}),
    description: `${capability.description}${rowActionSummary(capability.rowActions)}${authorizationSummary(requires)}`,
    ...(capability.rowActions ? { rowActions: capability.rowActions } : {}),
    inputSchema: capability.inputSchema as Record<string, unknown>,
    hints: { readOnly: true },
    anonymousDenied: declaresIdentity(requires),
    requiredScopes: declaredScopes(requires),
    route: { kind: "view", view: capability.manifest },
  };
}

function procedureCapability(capability: ProcedureCallableCapability): CapabilityDraft {
  const requires = capability.manifest.spec.requires;
  const hints = procedureHints(capability);
  return {
    name: capability.name,
    ...(capability.title ? { title: capability.title } : {}),
    description: `${capability.description}${idempotencySummary(capability.inputSchema)}${authorizationSummary(requires)}`,
    inputSchema: annotateExpectedVersion(capability.inputSchema as Record<string, unknown>),
    outputSchema: projectStandardOutputSchema(capability.outputSchema),
    ...(hints ? { hints } : {}),
    anonymousDenied: declaresIdentity(requires),
    requiredScopes: declaredScopes(requires),
    route: { kind: "procedure", trigger: capability.trigger },
  };
}

/**
 * Only what is provable, plus what the author declared (#972). A `ref`
 * handler is a black box, so nothing is inferred for it beyond the
 * idempotency key; a builtin handler always writes, and `delete` destroys.
 */
function procedureHints(capability: ProcedureCallableCapability): CapabilityHints | undefined {
  const spec = capability.manifest.spec;
  const hints: { -readonly [K in keyof CapabilityHints]: CapabilityHints[K] } = {};
  if (spec.handler.kind === "builtin") {
    hints.readOnly = false;
    if (spec.handler.op === "delete") hints.destructive = true;
  }
  if (idempotencyKeys(capability.inputSchema).length > 0) hints.idempotent = true;
  const declared = spec.mcp ?? {};
  if (declared.readOnlyHint !== undefined) hints.readOnly = declared.readOnlyHint;
  if (declared.destructiveHint !== undefined) hints.destructive = declared.destructiveHint;
  if (declared.openWorldHint !== undefined) hints.openWorld = declared.openWorldHint;
  return Object.keys(hints).length > 0 ? hints : undefined;
}

/** Every `requires.auth.all` predicate is unsatisfiable without a verified
 *  caller, so any declared predicate denies an anonymous one. */
function declaresIdentity(
  requires: ViewManifest["spec"]["requires"] | ProcedureCallableCapability["manifest"]["spec"]["requires"],
): boolean {
  return (requires?.auth?.all?.length ?? 0) > 0;
}

function declaredScopes(
  requires: ViewManifest["spec"]["requires"] | ProcedureCallableCapability["manifest"]["spec"]["requires"],
): string[] {
  return [...new Set((requires?.auth?.all ?? []).flatMap((predicate) =>
    typeof predicate === "object" && "ctx.auth.scope" in predicate ? [predicate["ctx.auth.scope"]] : []))];
}

/** Tell agents which operation a row feeds and how, so ids and versions are
 *  copied from the row instead of guessed. */
function rowActionSummary(actions: readonly ViewRowAction[] | undefined): string {
  if (!actions?.length) return "";
  const described = actions.map((action) => {
    const inputs = [
      ...action.bind.map(({ input, field }) => `${input} = row.${field}`),
      ...(action.version ? [`${action.version} = row.version`] : []),
    ];
    return `${action.capability} (${inputs.join(", ")})`;
  });
  return ` Row actions: ${described.join("; ")}.`;
}

function authorizationSummary(
  requires:
    | ProcedureCallableCapability["manifest"]["spec"]["requires"]
    | ViewCallableCapability["manifest"]["spec"]["requires"],
): string {
  if (!requires) return "";
  const scopes = (requires.auth?.all ?? []).flatMap((predicate) =>
    typeof predicate === "object" && "ctx.auth.scope" in predicate
      ? [predicate["ctx.auth.scope"]]
      : [],
  );
  const parts: string[] = [];
  if (requires.auth?.all?.length) {
    parts.push(
      scopes.length
        ? `authorization is enforced at call time; required scopes: ${scopes.join(", ")}`
        : "authorization is enforced at call time",
    );
  }
  if (requires.guard) {
    parts.push(`dynamic guard '${requires.guard.procedure}' runs on every call`);
  }
  return parts.length ? ` Authorization: ${parts.join("; ")}.` : "";
}

const OBSERVED_VERSION_DESCRIPTION =
  "Observed native entry.version at read time (not version+1). A successful write still bumps storage to this value + 1. First-party Admin/SDK bind this field automatically; other callers must send the version they read.";

function annotateExpectedVersion(schema: Record<string, unknown>): Record<string, unknown> {
  const properties = schema["properties"];
  if (!isRecord(properties) || !isRecord(properties["expectedVersion"])) return schema;
  const current = properties["expectedVersion"];
  const description = current["description"];
  if (typeof description === "string" && description.trim()) return schema;
  return {
    ...schema,
    properties: {
      ...properties,
      expectedVersion: { ...current, description: OBSERVED_VERSION_DESCRIPTION },
    },
  };
}

/** Surface `x-mcp-hint: idempotency-key` where an agent reads: the
 *  description. Nothing in the schema says a retry must reuse the value, and
 *  a fresh uuid re-executes the operation. */
function idempotencySummary(inputSchema: unknown): string {
  const keys = idempotencyKeys(inputSchema);
  if (keys.length === 0) return "";
  return ` Idempotency: retries must reuse the same ${keys.join(" / ")}; a new value is a new operation.`;
}

function idempotencyKeys(inputSchema: unknown): string[] {
  const properties = isRecord(inputSchema) ? inputSchema["properties"] : undefined;
  if (!isRecord(properties)) return [];
  return Object.entries(properties)
    .filter(([, property]) => isRecord(property) && property["x-mcp-hint"] === "idempotency-key")
    .map(([name]) => name);
}

/** Resolve LocalizedText `title`/`description` to English at every schema
 *  node, so callers see plain strings. */
function collapseSchemaAnnotations(schema: Record<string, unknown>): Record<string, unknown> {
  const out = { ...schema };
  for (const keyword of ["title", "description"] as const) {
    const value = schema[keyword] as JsonSchema[typeof keyword];
    if (value !== undefined) out[keyword] = resolveLocalizedText(value, "en");
  }
  for (const keyword of ["properties", "patternProperties", "dependentSchemas", "$defs", "definitions"]) {
    const children = schema[keyword];
    if (!isRecord(children)) continue;
    out[keyword] = Object.fromEntries(
      Object.entries(children).map(([name, child]) => [
        name,
        isRecord(child) ? collapseSchemaAnnotations(child) : child,
      ]),
    );
  }
  for (const keyword of [
    "additionalProperties",
    "unevaluatedProperties",
    "unevaluatedItems",
    "propertyNames",
    "items",
    "contains",
    "not",
    "if",
    "then",
    "else",
    "contentSchema",
  ]) {
    const child = schema[keyword];
    if (isRecord(child)) out[keyword] = collapseSchemaAnnotations(child);
  }
  for (const keyword of ["prefixItems", "allOf", "anyOf", "oneOf"]) {
    const children = schema[keyword];
    if (!Array.isArray(children)) continue;
    out[keyword] = children.map((child) => (isRecord(child) ? collapseSchemaAnnotations(child) : child));
  }
  return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Catalog entries are public and shared across callers, so nothing a
 *  caller can reach through one may mutate module state. */
function frozenCopy<T>(value: T): T {
  const freeze = (node: unknown): unknown => {
    if (typeof node !== "object" || node === null) return node;
    for (const child of Object.values(node)) freeze(child);
    return Object.freeze(node);
  };
  return freeze(structuredClone(value)) as T;
}
