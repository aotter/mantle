/**
 * K8s-style manifest envelope, scoped to the cms group of the mantle universe.
 *
 *   apiVersion: cms.mantle.aotter.net/v2
 *   kind: <Kind>
 *   metadata: { name }
 *   spec: { ... kind-specific ... }
 *
 * Sibling group `analytics.mantle.aotter.net/v1` lives in the parallel mantle (OLAP)
 * project and is parsed there — the two systems share lineage and mantle.ai
 * domain but not parsers.
 *
 * The parser rejects keys and enum values outside this shipped grammar.
 * Future syntax is added only with its implementation.
 */

/** v2 is the 0.2.0 grammar (ADR-0032 decision 5). A v1 manifest is rejected; `mantle-update` migrates it. */
export const API_VERSION = "cms.mantle.aotter.net/v2" as const;
export type ApiVersion = typeof API_VERSION;

/** Media-shaped `x-mcp-hint` values — the subset marking a field as
 *  holding a media asset URL. */
export type MediaMcpHint = "media" | "media-image" | "media-video" | "media-file";

export function isMediaMcpHint(value: unknown): value is MediaMcpHint {
  return (
    value === "media" ||
    value === "media-image" ||
    value === "media-video" ||
    value === "media-file"
  );
}

/** Loose JSON Schema shape — we don't constrain it at the type level.
 *  Manifest authoring stays JSON Schema; runtime validators translate
 *  to zod (Workers-CSP-safe). Cross-collection refs use the custom
 *  keyword `x-mantle-ref: <collectionName>` on string-typed fields holding
 *  foreign-key IDs; `x-mcp-hint` is a widget-intent hint. The grammar
 *  accepts strings; the v0.1 conventional values agents and admin
 *  widgets should understand are `markdown`, `richtext`, `code`,
 *  `media`, `media-image`, `media-video`, `media-file`, `money-minor`,
 *  `timestamp-ms`, and `idempotency-key`. */
export type JsonSchema = {
  readonly $defs?: Readonly<Record<string, JsonSchema>>;
  readonly $ref?: string;
  readonly oneOf?: readonly JsonSchema[];
  readonly const?: unknown;
  readonly type?: string | readonly string[];
  readonly properties?: Readonly<Record<string, JsonSchema>>;
  readonly required?: readonly string[];
  readonly items?: JsonSchema;
  readonly enum?: readonly unknown[];
  readonly format?: string;
  readonly pattern?: string;
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly minItems?: number;
  readonly maxItems?: number;
  readonly nullable?: boolean;
  /** Standard JSON Schema annotation. At the root of a Schema manifest,
   *  Mantle keeps generic Admin and Staff MCP authoring read-only while
   *  allowing trusted Procedure handlers to maintain the projection. */
  readonly readOnly?: boolean;
  readonly default?: unknown;
  readonly additionalProperties?: boolean | JsonSchema;
  /** Standard JSON Schema keyword: help text for this property, shown
   *  under the admin-UI form field (`entry-edit-view.tsx`) and the
   *  row-operation dialog's bound-field label fallback
   *  (`row-operations.tsx`). Accepts a plain string OR the same
   *  `LocalizedText` locale-map shape used by `Schema.spec.description`
   *  (#453, mirroring the property `title` keyword's #443 shape) —
   *  admin-ui resolves it client-side with `resolveLocalizedText`. `en`
   *  can stay the dev/OpenAPI-doc string while `zh-TW` etc. carry
   *  operator-readable copy. Optional; absent renders no help text
   *  (unchanged v0.1 behavior). */
  readonly description?: LocalizedText;
  /** Standard JSON Schema keyword (#443): a human-facing label for this
   *  property, for admin-UI form labels / list column headers /
   *  operation form labels. Accepts a plain string OR the same
   *  `LocalizedText` locale-map shape used by `Schema.spec.title` —
   *  admin-ui resolves it client-side with `resolveLocalizedText`, same
   *  as any other `LocalizedText` field. Optional; absent means the
   *  consumer humanizes the property name instead (unchanged v0.1
   *  behavior). */
  readonly title?: LocalizedText;
  /** Custom: cross-collection reference. The string form names the target
   *  Schema and means the value is that entry's `id`; the object form also
   *  names the target field (ADR-0029). */
  readonly "x-mantle-ref"?: string | MantleRefTarget;
  /** Custom: hint for MCP tool / agent prompt context. */
  readonly "x-mcp-hint"?: string;
  readonly [key: string]: unknown;
};

export const MANTLE_REF_KEYWORD = "x-mantle-ref" as const;

/** Object form of `x-mantle-ref`: which Schema the value points at, and
 *  which of its fields holds the value (`id` or a single-field unique
 *  index). */
export interface MantleRefTarget {
  readonly schema: string;
  readonly field: string;
}

/** Normalize either `x-mantle-ref` form, or `null` when the property carries
 *  none (or a malformed value, which graph validation reports). */
export function resolveMantleRef(property: unknown): MantleRefTarget | null {
  if (typeof property !== "object" || property === null) return null;
  const ref = (property as Record<string, unknown>)[MANTLE_REF_KEYWORD];
  if (typeof ref === "string") return ref.length > 0 ? { schema: ref, field: "id" } : null;
  if (typeof ref !== "object" || ref === null || Array.isArray(ref)) return null;
  const { schema, field } = ref as Record<string, unknown>;
  return typeof schema === "string" && schema.length > 0 && typeof field === "string" && field.length > 0
    ? { schema, field }
    : null;
}
export const MCP_HINT_KEYWORD = "x-mcp-hint" as const;
export const MANTLE_BIND_KEYWORD = "x-mantle-bind" as const;

/**
 * A human-facing label/blurb that is either a plain string (single
 * language, the v0.1 shape) or a map of locale code → string (e.g.
 * `{ en: "Products", "zh-TW": "商品" }`) so one manifest can serve a
 * multi-language admin UI. `Schema.spec.title`/`.description`,
 * `Procedure.spec.title`/`.description`, and `View.spec.title`/`.description`
 * use this shape; consumers resolve it to a single displayable string
 * with `resolveLocalizedText`.
 */
export type LocalizedText = string | Readonly<Record<string, string>>;

/**
 * Resolve a `LocalizedText` value to a single displayable string for
 * `preferred` (typically the viewer's chosen admin language), falling
 * back to `canonical` (the site's canonical locale) and finally to the
 * record's first own-enumerable entry (insertion order). A plain
 * string is returned as-is — even an empty string, since only
 * `null`/`undefined` map to `null` here; shape validation (rejecting
 * empty strings) is the parser's job, not this resolver's. `null` /
 * `undefined` input (the field was never set) resolves to `null`, and
 * an empty record (structurally invalid, but resolved defensively)
 * also resolves to `null` since there is nothing to fall back to.
 */
export function resolveLocalizedText(
  value: LocalizedText | null | undefined,
  preferred: string,
  canonical?: string | null,
): string | null {
  if (value == null) return null;
  if (typeof value === "string") return value;
  if (Object.prototype.hasOwnProperty.call(value, preferred)) {
    return value[preferred]!;
  }
  if (canonical && Object.prototype.hasOwnProperty.call(value, canonical)) {
    return value[canonical]!;
  }
  const firstKey = Object.keys(value)[0];
  return firstKey !== undefined ? value[firstKey]! : null;
}

/**
 * Four declarative atoms. Each maps 1-to-1 to a Postgres primitive — see
 * ADR-0001 / `docs/handbook/concepts/four-atoms.md` for the mapping. `Procedure`
 * is the only kind with a code seam (handler ref to consumer's TS file).
 */
export type ManifestKind = "Schema" | "View" | "Procedure" | "Trigger";

export interface ManifestMetadata {
  /** Resource identifier, e.g. `posts`. Required. Globally unique within
   *  `(kind, deployment)`. */
  readonly name: string;
}

interface ManifestEnvelope<K extends ManifestKind, S> {
  readonly apiVersion: ApiVersion;
  readonly kind: K;
  readonly metadata: ManifestMetadata;
  readonly spec: S;
}

/* ─── Schema ─── */

export type SchemaManifest = ManifestEnvelope<"Schema", SchemaManifestSpec>;

export interface SchemaManifestSpec {
  /** Human-readable label for the admin UI. Required at v0.1.x —
   *  the SPA renders this in the sidebar and elsewhere instead of
   *  the bare `metadata.name`. Either a plain string, or a
   *  `LocalizedText` map of locale → string (e.g.
   *  `{ en: "Products", "zh-TW": "商品" }`) so one manifest can serve a
   *  multi-language admin UI — the SPA resolves it client-side via
   *  `resolveLocalizedText`. AI authors MUST populate it in the user's
   *  primary language (the install-time chosen locale) at minimum,
   *  since end-admin users may not even read English. See ADR-0010 and
   *  the authoring contract § Schema authoring. */
  readonly title: LocalizedText;
  /** Same string-or-locale-map shape as `title`. Optional. */
  readonly description?: LocalizedText;
  /** JSON Schema Draft 2020-12 describing per-entry data. May carry the
   *  v0.1 property extensions: `x-mantle-bind`, `x-mantle-ref`, `x-mcp-hint`. */
  readonly schema: JsonSchema;
  /** Admin-only presentation. Closed Schema roots: `fields`, `list`,
   *  `nav`. Optional. */
  readonly uiSchema?: Record<string, unknown>;
  /** Composite unique-index declarations, e.g. `[[slug, locale]]`. */
  readonly uniqueIndexes?: ReadonlyArray<ReadonlyArray<string>>;
  /** Ordered composite non-unique indexes over top-level scalar fields. */
  readonly indexes?: ReadonlyArray<ReadonlyArray<string>>;
  /** Top-level string fields included in Admin/MCP free-text search.
   *  Entry id is always searched; absent or empty means id-only. This is
   *  intentionally independent from `indexes`: substring LIKE queries do
   *  not benefit from ordinary B-tree indexes. */
  readonly searchableFields?: readonly string[];
  /** Whether entries in this collection carry a per-row locale. Default
   *  `false`. When `true`, `data.locale` MUST be present and ∈ site
   *  `locales`; when `false`, `data.locale` MUST be absent. See
   *  ADR-0010. Mutually constrained with `translates`. */
  readonly localized?: boolean;
  /** Parent/child translation pattern: this Schema is the translatable
   *  companion to a non-localized parent Schema, joined by a shared
   *  field. Requires explicit `localized: true` and at least one
   *  locale-specific field besides `locale` and the join field. See ADR-0010. */
  readonly translates?: TranslatesBinding;
  /** Content-workflow mode. Default `'publishing'` (draft → published →
   *  archived, no approval queue). `'operational'` marks record
   *  Schemas (orders, inventory snapshots, audit rows) that are written
   *  by Procedures rather than authored: entries are live on creation,
   *  editable in place, and have no publish/unpublish transitions — the
   *  admin hides the content-lifecycle chrome for them. */
  readonly lifecycle?: LifecycleMode;
  /** Logical expiry policy. Physical removal requires an explicit sweep. */
  readonly ttl?: { readonly field: string; readonly expireAfterSeconds: number };
  /** Caller identity scope for Store operations. The field must be required and indexed first. */
  readonly scope?: Readonly<Record<string, "$ctx.user.id">>;
}

export interface TranslatesBinding {
  /** Name of the parent Schema this translation table joins to. Must
   *  resolve to a declared Schema; the parent itself MUST NOT be
   *  `localized: true` (it carries the non-translatable facts). */
  readonly parent: string;
  /** Field present in both parent's and this Schema's
   *  `spec.schema.properties` and used as the join key. Conventionally
   *  `slug` for content, but any stable identifier works. */
  readonly on: string;
}

export type LifecycleMode = "publishing" | "operational";

/* ─── View ─── */

export type ViewManifest = ManifestEnvelope<"View", ViewManifestSpec>;

export interface ViewCachePolicy {
  /** Maximum shared-cache staleness for anonymous REST reads, in seconds. */
  readonly sharedMaxAge: number;
}

export const VIEW_SURFACES = ["public", "staff", "internal"] as const;
export type ViewSurface = (typeof VIEW_SURFACES)[number];

/**
 * Value references, one set for every Store IR position (View `select`,
 * inline Procedure programs, Schema `scope`):
 *   `$input.<name>`  a declared input property
 *   `$ctx.user.id`   the caller's application subject key (ADR-0032 decision 8)
 *   `$now`           the invocation time
 *   `{ $literal: <string> }`  a string that starts with `$`
 */
export const STORE_VALUE_REFERENCES = ["$ctx.user.id", "$now"] as const;
export const STORE_INPUT_REFERENCE_PREFIX = "$input." as const;
export interface StoreLiteral {
  readonly $literal: string;
}

/** Store where, as ADR-0030 defines it: `{ column: value }` is equality,
 *  sibling keys AND, operators `eq ne gt gte lt lte like in notIn isNull`,
 *  `and` / `or` / `not`, subqueries inside `in` / `notIn`. */
export type StoreWhereSpec = Readonly<Record<string, unknown>>;

/** A named Store select. Identifiers are Schema-validated; values are
 *  literals or value references. */
export interface ViewSelectSpec {
  readonly from: string;
  readonly columns?: readonly string[];
  readonly where?: StoreWhereSpec;
  readonly orderBy?: Readonly<Record<string, "asc" | "desc">>;
  readonly limit?: number;
}

export interface ViewManifestSpec {
  /** Human-readable label for the admin UI. Plain string or locale map. */
  readonly title?: LocalizedText;
  /** What the View answers, for agents and people choosing a query
   *  (ADR-0029). Projected into the View's MCP tool description. */
  readonly description?: LocalizedText;
  /** Admin-only presentation for `surface: staff` Views:
   *  `list.columns`, `searchFields` (compiled to `like`) and
   *  `filterFields` (compiled to `eq`). */
  readonly uiSchema?: Record<string, unknown>;
  /** Exactly one of `select` or `sql`. */
  readonly select?: ViewSelectSpec;
  /** A single read-only SQLite SELECT over Schema logical tables; the
   *  escape hatch for aggregation and joins. Named `:params` bind declared
   *  `input` properties. It may not read a scoped Schema. */
  readonly sql?: string;
  /** `public` mounts on the REST and MCP public surfaces, `staff` behind the
   *  staff gate, `internal` on no surface (callable through Store only). */
  readonly surface: ViewSurface;
  /** Anonymous shared-cache policy; only for unguarded public `select` Views. */
  readonly cache?: ViewCachePolicy;
  /** Same shape as `ProcedureManifestSpec.requires`. */
  readonly requires?: AuthorizationRequirements;
  /** Caller input: `type: object` with declared `properties`. `limit` and
   *  `cursor` are reserved for pagination. Renamed from v1 `params`. */
  readonly input?: JsonSchema;
}

/** Pagination names every View surface owns; `input` may not declare them. */
export const VIEW_INPUT_RESERVED = ["limit", "cursor"] as const;
export type ViewInputReserved = (typeof VIEW_INPUT_RESERVED)[number];

/* ─── Procedure ─── */

export type ProcedureManifest = ManifestEnvelope<"Procedure", ProcedureManifestSpec>;

export interface ProcedureManifestSpec {
  /** Human-readable label for the admin UI's staff-operations surface
   *  (#430). Same string-or-locale-map `LocalizedText` shape as
   *  `Schema.spec.title`. Optional — Procedures didn't carry a title
   *  before v0.1.x; when absent the admin UI falls back to a
   *  Title-Cased rendering of `metadata.name`. */
  readonly title?: LocalizedText;
  /** Same string-or-locale-map shape as `title`. Optional. Surfaced by
   *  `GET /admin/api/operations` as the operation's `description`
   *  field (replaces the pre-#430 hack of reading
   *  `spec.input.description`). */
  readonly description?: LocalizedText;
  /** Authorization via `requires.auth.all` plus one optional
   *  `requires.guard.procedure`; static predicates are closed to
   *  `ctx.user`, `ctx.staff`, `ctx.auth`, and `ctx.auth.scope`. */
  readonly requires?: AuthorizationRequirements;
  /** JSON Schema for the request body. */
  readonly input: JsonSchema;
  /** Admin-only field widget choices. Does not affect input validation
   *  or the MCP tool schema. */
  readonly uiSchema?: Record<string, unknown>;
  /** JSON Schema for the response body. */
  readonly output: JsonSchema;
  /** A `ref` into the service's `MantleHandlers`, or an inline Store
   *  program of write ops. */
  readonly handler: HandlerBinding;
  /** MCP tool annotations the author declares because Core cannot infer
   *  them for a `ref` handler (#972). Emitted verbatim on the tool;
   *  `idempotentHint` is inferred from an `x-mcp-hint: idempotency-key`
   *  input and is not declarable. A `readOnlyHint: true` on an inline
   *  Store program is rejected at validation, since it always writes. */
  readonly mcp?: ProcedureMcpAnnotations;
  /** The entity the Procedure mutates and whose version it locks
   *  (ADR-0029). Inferred for an inline program with exactly one row op
   *  whose `where` pins `id` to an input property; explicit otherwise. */
  readonly target?: ProcedureTarget;
}

export interface ProcedureTarget {
  /** Target Schema. */
  readonly schema: string;
  /** Required string input property carrying the target entry id. */
  readonly id: string;
  /** Number input property carrying the observed version, when locked. */
  readonly version?: string;
}
export const PROCEDURE_TARGET_KEYS = ["schema", "id", "version"] as const;

export interface ProcedureMcpAnnotations {
  readonly readOnlyHint?: boolean;
  readonly destructiveHint?: boolean;
  readonly openWorldHint?: boolean;
}
export const PROCEDURE_MCP_ANNOTATION_KEYS = ["readOnlyHint", "destructiveHint", "openWorldHint"] as const;

export type HandlerBinding = HandlerRefBinding | HandlerStoreBinding;

export interface HandlerRefBinding {
  /** Opaque key into the service's `MantleHandlers` (not a path). The plan's
   *  refs and the handler map must match one to one. */
  readonly ref: string;
}

/** An inline Store program: write ops applied as one all-or-nothing
 *  `store.write`. Views read; Procedures write. The Procedure output is
 *  `{ results }`, the write results in op order. */
export interface HandlerStoreBinding {
  readonly store: readonly StoreProgramOp[];
}

export type StoreProgramOp = StoreProgramInsert | StoreProgramUpdate | StoreProgramDelete;

/**
 * Values are literals or value references. In `values` and `set`, a
 * reference to an optional input property that the caller omits is left
 * out of the write; in `where`, `id` and `lock` a reference must name a
 * required, non-null scalar.
 */
export interface StoreProgramInsert {
  readonly insert: string;
  readonly values: Readonly<Record<string, unknown>>;
  /** Client id; omitted generates one. */
  readonly id?: unknown;
  /** `ignore` skips a unique conflict; the object form updates `update`
   *  columns on a conflict over `columns` (a declared unique index). */
  readonly onConflict?: "ignore" | { readonly columns: readonly string[]; readonly update: readonly string[] };
}

export interface StoreProgramUpdate {
  readonly update: string;
  readonly set: Readonly<Record<string, unknown>>;
  readonly where: StoreWhereSpec;
  /** Caller-observed version (ADR-0022); requires a row op. */
  readonly lock?: unknown;
  /** Affected-row count; a mismatch rolls the whole write back. */
  readonly expect?: number;
}

export interface StoreProgramDelete {
  readonly delete: string;
  readonly where: StoreWhereSpec;
  readonly lock?: unknown;
  readonly expect?: number;
}

/** Closed predicate vocabulary. `ctx.user` and `ctx.auth` are bare
 *  strings; `ctx.staff` and `ctx.auth.scope` carry scalar data under
 *  literal object keys.
 */
export interface AuthorizationRequirements {
  readonly auth?: { readonly all: readonly AuthPredicate[] };
  /** Dynamic, consumer-owned authorization check. The named Procedure
   *  receives the target's validated input/params and the same
   *  HandlerContext before the target executes. */
  readonly guard?: { readonly procedure: string };
}

export type AuthPredicate =
  | CtxUserPredicate
  | CtxStaffPredicate
  | CtxAuthPredicate
  | CtxAuthScopePredicate;
export type CtxUserPredicate = "ctx.user";
/** Requires any verified credential normalized into HandlerContext.auth. */
export type CtxAuthPredicate = "ctx.auth";
export interface CtxStaffPredicate {
  readonly "ctx.staff": readonly StaffRole[];
}
/** Requires one opaque, consumer-owned scope. Repeat under `all` for
 *  multiple required scopes. */
export interface CtxAuthScopePredicate {
  readonly "ctx.auth.scope": string;
}

/**
 * Staff role hierarchy. `users` is the base identity layer (runtime);
 * `staff` is the privilege overlay (one row per privileged user). A
 * user without a staff row is a regular site member with no admin
 * access.
 *
 *   owner       — full control, manages staff, manages settings
 *   editor      — publish, approve/reject, manage all entries
 *   contributor — create and edit drafts
 *
 * `StaffRole` lives in spec because the manifest grammar references
 * it directly: `requires.auth.all: [{ "ctx.staff": [<role>, ...] }]`
 * — the parser checks each role string is in `STAFF_ROLES` at boot.
 * The `Staff` runtime row shape (with grantedBy / grantedAt) lives in
 * `mantle-runtime`; only the closed enum is grammar.
 */
export const STAFF_ROLES = ["owner", "editor", "contributor"] as const;
export type StaffRole = (typeof STAFF_ROLES)[number];

// `meetsRole` (role-rank comparison) moved to
// `domain/service/StaffRoleHierarchy.ts` — this file is pure grammar
// types referenced by the parser.

export function isStaffRole(s: string): s is StaffRole {
  return (STAFF_ROLES as readonly string[]).includes(s);
}

/* ─── Trigger ─── */

export type TriggerManifest = ManifestEnvelope<"Trigger", TriggerManifestSpec>;

export interface TriggerManifestSpec {
  readonly source: TriggerSource;
  /** The Procedure invoked when this Trigger fires. */
  readonly target: { readonly procedure: string };
}

/** Supported Trigger sources. */
export type TriggerSource =
  | HttpTriggerSource
  | LifecycleTriggerSource
  | McpTriggerSource
  | ScheduleTriggerSource;

/** A five-field POSIX cron expression in UTC (minute hour day month
 *  weekday, 0 = Sunday). A host translates it to its own dialect;
 *  registration remains host-owned. */
export interface ScheduleTriggerSource {
  readonly kind: "schedule";
  readonly cron: string;
  readonly enabled?: boolean;
}

export interface HttpTriggerSource {
  readonly kind: "http";
  readonly method: HttpMethod;
  /** OpenAPI `{param}` syntax. Path params auto-bind to identically-named
   *  fields on the target Procedure's `input`. No optional segments. */
  readonly path: string;
}

/** Shipped v0.1 lifecycle hook vocabulary: before/after ×
 *  create/update/delete plus the publish boundary. New entries require an
 *  explicit grammar-revise round. */
export const LIFECYCLE_HOOKS = [
  "before_create",
  "after_create",
  "before_update",
  "after_update",
  "before_delete",
  "after_delete",
  "before_publish",
  "after_publish",
] as const;
export type LifecycleHook = (typeof LIFECYCLE_HOOKS)[number];

export interface LifecycleTriggerSource {
  readonly kind: "lifecycle";
  /** Schema this Trigger watches (`Schema.metadata.name`). */
  readonly schema: string;
  /** Hooks bound by this Trigger. Non-empty. A `before_*` hook is a
   *  read-only check that fails closed; an `after_*` hook runs best effort
   *  after the commit. The target Procedure must have a `ref` handler. */
  readonly on: readonly LifecycleHook[];
}

/** Surfaces an MCP-source Trigger can be bound to. `staff` ⇒
 *  `/mcp/staff` (bearer + role gate); `public` ⇒ `/mcp` (bearer only).
 *  The procedure's own `requires.auth` still gates the call —
 *  surface determines visibility in `tools/list`. */
export const MCP_TRIGGER_SURFACES = ["staff", "public"] as const;
export type McpTriggerSurface = (typeof MCP_TRIGGER_SURFACES)[number];

export interface McpTriggerSource {
  readonly kind: "mcp";
  /** Which MCP surface this Procedure is callable from. The
   *  Procedure's `requires.auth` continues to evaluate against the
   *  authenticated caller — surface only controls discovery. */
  readonly surface: McpTriggerSurface;
}

/** v0.1 HTTP methods that may carry a body. GET is intentionally absent
 *  — read endpoints are Views, not Procedures. */
export type HttpMethod = "POST" | "PUT" | "PATCH" | "DELETE";

/* ─── Union ─── */

export type Manifest = SchemaManifest | ViewManifest | ProcedureManifest | TriggerManifest;

/** v0.1 closed enum for `x-mantle-bind` Schema-property values. New entries
 *  require an explicit grammar-revise round (see ADR-0002). */
export const MANTLE_BIND_VALUES = ["ctx.user", "ctx.staff", "now"] as const;
export type MantleBindValue = (typeof MANTLE_BIND_VALUES)[number];

/** Storage-row metadata columns reserved across every Schema. Used by
 *  the View SQL compiler (to project them as native columns rather
 *  than `json_extract`) and by the type emitter (to surface them on
 *  every Entry interface). Adding a new reserved column is a grammar
 *  revise — touch this constant + every consumer. */
export const RESERVED_ENTRY_COLUMNS = [
  "id",
  "status",
  "version",
  "createdAt",
  "updatedAt",
  "authorId",
] as const;
export type ReservedEntryColumn = (typeof RESERVED_ENTRY_COLUMNS)[number];

/**
 * Reserved Procedure input wire names. `expectedVersion` is the observed
 * native `entry.version` at read time (not version+1). First-party Admin/SDK
 * bind and hide it; other callers supply it. Schema `spec.schema.properties`
 * must not collide — validate is fail-closed (`INVALID_MANIFEST_ENVELOPE`).
 * New reserved names need an ADR (ADR-0022).
 */
export const EXPECTED_VERSION_PROPERTY = "expectedVersion" as const;
export const RESERVED_PROCEDURE_INPUT_NAMES = [EXPECTED_VERSION_PROPERTY] as const;
export type ReservedProcedureInputName = (typeof RESERVED_PROCEDURE_INPUT_NAMES)[number];
