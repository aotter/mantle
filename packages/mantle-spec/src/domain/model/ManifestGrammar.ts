/**
 * K8s-style manifest envelope, scoped to the cms group of the mantle universe.
 *
 *   apiVersion: cms.mantle.aotter.net/v1
 *   kind: <Kind>
 *   metadata: { name }
 *   spec: { ... kind-specific ... }
 *
 * Sibling group `analytics.mantle.aotter.net/v1` lives in the parallel mantle (OLAP)
 * project and is parsed there — the two systems share lineage and mantle.ai
 * domain but not parsers.
 *
 * v0.1 grammar lock — see `docs/design-atoms.md` and ADR-0001
 * § "Future grammar discipline". DRAFT keys (policies, recursive views,
 * temporal predicates, quotas, projection triggers, and cron / queue
 * Trigger source kinds) are intentionally absent from this file and rejected
 * until a grammar promotion.
 *
 * v0.1 ships builtin Procedure handlers plus MCP and lifecycle Trigger
 * sources. `Schema.spec.lifecycle: editorial` is structurally accepted for
 * forward compatibility, but its approval/request-publish runtime remains
 * deferred with a feature-specific diagnostic.
 */

export const API_VERSION = "cms.mantle.aotter.net/v1" as const;
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
 *  and `timestamp-ms`. */
export type JsonSchema = {
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
  /** Custom: cross-collection reference target. */
  readonly "x-mantle-ref"?: string;
  /** Custom: hint for MCP tool / agent prompt context. */
  readonly "x-mcp-hint"?: string;
  readonly [key: string]: unknown;
};

export const MANTLE_REF_KEYWORD = "x-mantle-ref" as const;
export const MCP_HINT_KEYWORD = "x-mcp-hint" as const;
export const MANTLE_BIND_KEYWORD = "x-mantle-bind" as const;

/**
 * A human-facing label/blurb that is either a plain string (single
 * language, the v0.1 shape) or a map of locale code → string (e.g.
 * `{ en: "Products", "zh-TW": "商品" }`) so one manifest can serve a
 * multi-language admin UI. `Schema.spec.title`/`.description`,
 * `Procedure.spec.title`/`.description`, and `View.spec.title` (#443)
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
 * ADR-0001 / `docs/design-atoms.md` § TL;DR for the mapping. `Procedure`
 * is the only kind with a code seam (handler ref to consumer's TS file).
 */
export type ManifestKind = "Schema" | "View" | "Procedure" | "Trigger";

export interface ManifestMetadata {
  /** Resource identifier, e.g. `posts`. Required. Globally unique within
   *  `(kind, deployment)`. */
  readonly name: string;
  /** Free-form labels for filtering / discovery. Reserved; not used today. */
  readonly labels?: Readonly<Record<string, string>>;
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
  /** JSON Forms uiSchema. Optional. */
  readonly uiSchema?: Record<string, unknown>;
  /** Composite unique-index declarations, e.g. `[[slug, locale]]`. */
  readonly uniqueIndexes?: ReadonlyArray<ReadonlyArray<string>>;
  /** Ordered composite non-unique indexes over top-level scalar fields. */
  readonly indexes?: ReadonlyArray<ReadonlyArray<string>>;
  /** Whether entries in this collection carry a per-row locale. Default
   *  `false`. When `true`, `data.locale` MUST be present and ∈ site
   *  `locales`; when `false`, `data.locale` MUST be absent. See
   *  ADR-0010. Mutually constrained with `translates`. */
  readonly localized?: boolean;
  /** Parent/child translation pattern: this Schema is the translatable
   *  companion to a non-localized parent Schema, joined by a shared
   *  field. Implies `localized: true`. See ADR-0010. */
  readonly translates?: TranslatesBinding;
  /** Content-workflow opt-in. Default `'simple'` (draft → published →
   *  archived, no approval queue). `'none'` marks operational record
   *  Schemas (orders, inventory snapshots, audit rows) that are written
   *  by Procedures rather than authored: entries are live on creation,
   *  editable in place, and have no publish/unpublish transitions — the
   *  admin hides the content-lifecycle chrome for them. The parser and boot
   *  accept all three values structurally; the v0.1 `request_publish` use case
   *  rejects `'editorial'` with a clear deferred-runtime diagnostic. */
  readonly lifecycle?: LifecycleMode;
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

export type LifecycleMode = "simple" | "editorial" | "none";

/* ─── View ─── */

export type ViewManifest = ManifestEnvelope<"View", ViewManifestSpec>;

export interface ViewManifestSpec {
  /** Human-readable label for the admin UI's report sidebar / report
   *  page (#443). Same string-or-locale-map `LocalizedText` shape as
   *  `Schema.spec.title`. Optional — Views didn't carry a title before
   *  v0.1.x; when absent the admin UI falls back to a Title-Cased
   *  rendering of `metadata.name`, exactly as before this field
   *  existed. */
  readonly title?: LocalizedText;
  /** Source Schema name (bare; no namespace). */
  readonly from: string;
  /** REST-surface visibility. Reuses the `"public" | "staff"`
   *  vocabulary of `McpTriggerSurface` (see `MCP_TRIGGER_SURFACES`).
   *  When absent or `"public"` the View auto-mounts at the public
   *  `GET /api/views/<name>` (v0.1 default; `requires` may still gate
   *  the call). When `"staff"` the View is
   *  NOT mounted on the public path — it mounts at
   *  `GET /admin/api/views/<name>` behind the staff gate and becomes
   *  the report-sidebar source. Guards data behind a staff session; use
   *  it for any View over sensitive rows. */
  readonly surface?: McpTriggerSurface;
  /** Auth gate. Identical shape to `ProcedureManifestSpec.requires.auth`.
   *  When absent the View is public — `ExecuteViewUseCase` skips the
   *  predicate check. When present, ALL predicates must hold; the
   *  runtime enforces with `evaluateAuthAll`. Closed predicate
   *  vocabulary: `ctx.user`, `ctx.staff`, `ctx.auth`, and
   *  `ctx.auth.scope`; an optional guard names one consumer Procedure. */
  readonly requires?: AuthorizationRequirements;
  /** Filter AST. v0.1 grammar: comparison ops plus and/or. Comparison
   *  values may be literals or `{ $param: <name> }` sentinels referencing
   *  `spec.params`. */
  readonly filter?: FilterAst;
  /** Projection. */
  readonly fields?: readonly string[];
  /** Order. */
  readonly orderBy?: ReadonlyArray<{ readonly field: string; readonly direction?: "asc" | "desc" }>;
  /** Server-enforced cap on rows returned per call. The public REST
   *  surface accepts `?show=<n>`; the runtime trims to `min(show, limit)`.
   *  Defaults to a runtime-internal value (50) when absent. */
  readonly limit?: number;
  /** Caller-supplied parameter shape for the public REST surface
   *  (`GET /api/views/<name>`). MUST be `type: "object"` with declared
   *  `properties`. Reserved names (`page`, `show`, `cursor`) are rejected
   *  by the parser since the runtime owns those for pagination. */
  readonly params?: JsonSchema;
}

/** v0.1 View filter comparison operators. */
export const FILTER_COMPARISON_OPS = ["eq", "gt", "gte", "lt", "lte"] as const;
export type FilterComparisonOp = (typeof FILTER_COMPARISON_OPS)[number];

/** v0.1 filter AST. Anything beyond comparison/and/or is DRAFT (`contains`,
 *  `not`, `in`, `like`, `recursive`, `gatedBy`, `join.aggregate`). */
export type FilterAst = FilterComparison | FilterAnd | FilterOr;
export type FilterComparison = FilterEq | FilterGt | FilterGte | FilterLt | FilterLte;
interface FilterComparisonNode {
  readonly field: string;
  /** Comparison value. Either a literal or a `ParamRef` sentinel
   *  (`{ $param: <name> }`) substituted at request time from
   *  `View.spec.params`. See `isParamRef`. */
  readonly value: unknown;
}
export interface FilterEq {
  readonly eq: FilterComparisonNode;
}
export interface FilterGt {
  readonly gt: FilterComparisonNode;
}
export interface FilterGte {
  readonly gte: FilterComparisonNode;
}
export interface FilterLt {
  readonly lt: FilterComparisonNode;
}
export interface FilterLte {
  readonly lte: FilterComparisonNode;
}

/** Sentinel object form for filter values that pull from caller-supplied
 *  params at request time. The discriminator key `$param` was chosen to
 *  match the JSON Schema `$ref` convention; future sentinels for `now`,
 *  `ctx.user`, etc. follow the same `$<name>` shape. */
export interface ParamRef {
  readonly $param: string;
}

export function isParamRef(v: unknown): v is ParamRef {
  return (
    typeof v === "object" &&
    v !== null &&
    !Array.isArray(v) &&
    typeof (v as Record<string, unknown>)["$param"] === "string"
  );
}

/** Reserved query-string names on the public View REST surface
 *  (`/api/views/<name>?...`). The runtime owns these for pagination; a
 *  View manifest that declares `params.<name>` for any of them is
 *  rejected at parse time (`VIEW_PARAMS_RESERVED_NAME`). */
export const VIEW_PARAMS_RESERVED = ["page", "show", "cursor"] as const;
export type ViewParamReserved = (typeof VIEW_PARAMS_RESERVED)[number];
export interface FilterAnd {
  readonly and: readonly FilterAst[];
}
export interface FilterOr {
  readonly or: readonly FilterAst[];
}

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
  /** Authorization. v0.1: `requires.auth.all` plus one optional
   *  `requires.guard.procedure`; static predicates are closed to
   *  `ctx.user`, `ctx.staff`, `ctx.auth`, and `ctx.auth.scope`. DRAFT:
   *  `requires.auth.any`, `owns:`, `withinMinutes:`, `contains:`,
   *  `requires.window`, `requires.quota`. See ADR-0002. */
  readonly requires?: AuthorizationRequirements;
  /** JSON Schema for the request body. */
  readonly input: JsonSchema;
  /** JSON Schema for the response body. */
  readonly output: JsonSchema;
  /** Handler binding. v0.1.0 ships `kind: "ref"` (consumer supplies
   *  a handler map) and `kind: "builtin"` (5-op CRUD shortcut over
   *  the entry-writer chokepoint). */
  readonly handler: HandlerBinding;
}

export type HandlerBinding = HandlerRefBinding | HandlerBuiltinBinding;
export interface HandlerRefBinding {
  readonly kind: "ref";
  /** Opaque registration key (NOT a path). The consumer passes a matching
   *  key in the runtime/Worker `handlers` map. */
  readonly ref: string;
}

/** Shipped v0.1 builtin op vocabulary. `archive` is runtime-wired but
 *  meaningful only for a lifecycle that can transition to archived.
 *  New entries require an explicit grammar-revise round. */
export const BUILTIN_OPS = ["create", "update", "upsert", "delete", "archive"] as const;
export type BuiltinOp = (typeof BUILTIN_OPS)[number];

export interface HandlerBuiltinBinding {
  readonly kind: "builtin";
  /** Storage op. */
  readonly op: BuiltinOp;
  /** Target Schema name (`Schema.metadata.name`). The op writes to
   *  this collection. */
  readonly schema: string;
}

/** v0.1 closed predicate vocabulary. `ctx.user` and `ctx.auth` are bare
 *  strings; `ctx.staff` and `ctx.auth.scope` carry scalar data under
 *  literal object keys.
 *
 *  v0.1.x roadmap (annotation only — DO NOT IMPLEMENT until ADR-promoted):
 *  extend with `ctx.user.{tier, verified, owns, in-group}` when platform
 *  mode lands and user-level auth is needed. Closed enums for `tier` /
 *  group identity will live next to STAFF_ROLES below. */
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
 *   contributor — create drafts, request publish, sees only own entries
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

/** v0.1.0 ships `http`, `lifecycle`, and `mcp`. `cron` / `queue` stay
 *  DRAFT and are rejected by the parser with DRAFT_KEY_USED. `mcp`
 *  was promoted from DRAFT in alpha.16 (#281): it lets a Procedure
 *  expose itself as a tool on `/mcp/staff` or `/mcp` without a
 *  parallel hand-wired HTTP handler. */
export type TriggerSource =
  | HttpTriggerSource
  | LifecycleTriggerSource
  | McpTriggerSource;

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

export type HookErrorPolicy = "abort" | "continue";

export interface LifecycleTriggerSource {
  readonly kind: "lifecycle";
  /** Schema this Trigger watches (`Schema.metadata.name`). */
  readonly schema: string;
  /** Hooks bound by this Trigger. Non-empty. */
  readonly on: readonly LifecycleHook[];
  /** Override the per-phase default. before_* defaults to "abort";
   *  after_* defaults to "continue". */
  readonly errorPolicy?: HookErrorPolicy;
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
