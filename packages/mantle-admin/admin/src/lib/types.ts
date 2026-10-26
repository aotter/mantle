/** Human-facing copy as a plain string or locale map. */
export type LocalizedText = string | Readonly<Record<string, string>>;

export type Lifecycle = "publishing" | "operational";

export type ContentStatus =
  | "draft"
  | "published"
  | "archived";

export type SidebarStatus = ContentStatus;

export interface Collection {
  name: string;
  /** Generated fields approved for CSV, excluding scope and non-exportable geometry. */
  exportFields: string[];
  /** The Schema's `uiSchema` as declared (Admin presentation only). */
  uiSchema?: Record<string, unknown> | null;
  title: LocalizedText;
  description: LocalizedText | null;
  lifecycle: Lifecycle;
  parent?: {
    collection: string;
    parentField: string;
    childField: string;
  } | null;
  /** `true` when some other Schema lists this collection as the
   *  `translates.parent` — i.e. it is the i18n parent in a parent +
   *  translations pair. Translation-child Schemas (those with
   *  `spec.translates`) are filtered out of `/admin/api/collections`
   *  entirely; they fold into their parent in the sidebar. */
  hasTranslations: boolean;
  /** The collection's own rows carry a locale. */
  localized: boolean;
  /** Schema properties carrying `x-mcp-hint: media-*`. Upload hosting
   *  is optional; this only marks which fields are media-shaped. */
  mediaFields?: Array<{ name: string; hint: string }>;
  /** Required scalar fields backed by a declared Schema index. */
  sortableFields?: string[];
  /** Fields the list search matches besides the entry id (`searchableFields`); empty searches id only. */
  searchableFields?: string[];
  /** Primary Admin list filter declared at uiSchema.list.filterField. */
  filter?: { field: string; values: string[] } | null;
  /** Operational list data fields resolved from uiSchema.list. */
  list?: { primaryField: string | null; columns: string[] };
  /** Standalone main-Nav co-entry. Fold parent stays on `parent`. */
  nav?: {
    standalone: true;
    parentField: string;
    parentCollection: string;
  } | null;
  /** Translation-child Schemas set this; they are not workbench/subnav children. */
  translates?: { parent: string; on: string } | null;
  schema?: JsonSchema;
}

export interface JsonSchema {
  type?: string | string[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: unknown[];
  format?: string;
  pattern?: string;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
  nullable?: boolean;
  readOnly?: boolean;
  default?: unknown;
  additionalProperties?: boolean | JsonSchema;
  /** Optional JSON Schema help text. */
  description?: LocalizedText;
  /** Optional JSON Schema field label. */
  title?: LocalizedText;
  "x-mantle-bind"?: string;
  "x-mantle-ref"?: string | { schema: string; field: string };
  "x-mcp-hint"?: string;
  [key: string]: unknown;
}

/** Either `x-mantle-ref` form as `{ schema, field }`; the string form means
 *  the value is the target entry's `id`. */
export function mantleRefOf(schema: JsonSchema | undefined): { schema: string; field: string } | null {
  const ref = schema?.["x-mantle-ref"];
  if (typeof ref === "string") return ref ? { schema: ref, field: "id" } : null;
  if (ref && typeof ref === "object" && typeof ref.schema === "string" && typeof ref.field === "string") return ref;
  return null;
}

export interface EntryEditorCollection extends Collection {
  translates: { parent: string; on: string } | null;
  schema: JsonSchema;
  uiSchema: Record<string, unknown> | null;
}

export interface EntryEditorEntry {
  id: string;
  collection: string;
  locale: string | null;
  status: ContentStatus | null;
  version: number | string;
  data: Record<string, unknown>;
  created_at?: number | null;
  updated_at: number;
  /** Present when the Schema declares locks (#1822): whether one holds for this row's update or delete, and the first one's message. */
  locks?: EntryLocks;
}

export interface EntryLocks {
  update: boolean;
  delete: boolean;
  lock?: string;
  message?: string;
}

export interface RelatedEntrySection {
  collection: EntryEditorCollection;
  relationship: {
    kind: "translation" | "field";
    parentField: string;
    childField: string;
    parentValue: string | number | boolean | null;
  };
  entries: EntryEditorEntry[];
}

/** Native API data; relationship and title presentation belongs to the SPA. */
export interface EntryDocument {
  collection: EntryEditorCollection;
  entry: EntryEditorEntry;
}
export interface EntryPage {
  items: EntryEditorEntry[];
  next_cursor: string | null;
}
export interface CollectionsMetadata {
  collections: Collection[];
  allCollections: Record<string, Collection>;
}

/** Titles of referenced records the caller may read, by referencing field then by the stored value; anything unresolved is absent. */
export type RefTitles = Readonly<Record<string, Readonly<Record<string, { collection: string; id: string; title: string }>>>>;

export interface EntryEditorPayload {
  collection: EntryEditorCollection;
  entry: EntryEditorEntry;
  parentEntryId: string | null;
  parentEntryTitle?: string | null;
  refTitles?: RefTitles;
  related: RelatedEntrySection[];
}

export type AdminRole = string;

export interface AdminUser {
  login: string | null;
  image: string | null;
  role: AdminRole | null;
  admin: boolean;
  userId?: string;
}

/** Public sign-in capabilities returned by `GET /api/auth/methods`. */
export type AuthMethodInfo =
  | { kind: "email-otp" }
  | { kind: "magic-link" }
  | { kind: "social"; provider: string }
  | { kind: "oauth"; providerId: string; displayName?: string };

/** Row from `GET /admin/api/admin` (admin-only). `createdAt` arrives
 *  as an ISO string over the wire. `emailVerified: false` with no
 *  `githubLogin` marks a pending invitation nobody has signed in to. */
export interface AdminIdentity {
  id: string;
  email: string;
  name: string;
  role: string | null;
  githubLogin: string | null;
  emailVerified: boolean;
  createdAt: string;
}

export interface MemberUser {
  role?: string | null;
  id: string;
  email: string;
  name: string;
  emailVerified: boolean;
  createdAt: string;
}

export interface MemberListResult {
  adminRoles?: string[];
  items: MemberUser[];
  next_cursor: string | null;
}

export interface EntryRow {
  id: string;
  collection: string;
  locale: string | null;
  status: string | null;
  version: number | string;
  title: unknown;
  updated_at: number;
  translation_locales: string[];
  /** Explicit uiSchema.list data fields for operational collections. */
  data_preview?: Record<string, unknown>;  locks?: EntryLocks;
}

export interface ListEntriesResult {
  items: EntryRow[];
  ref_titles?: RefTitles;
  next_cursor: string | null;
}

/** `uiSchema.nav` placement in Admin's sidebar (presentation only). */
export interface NavPlacement { group?: string; order?: number; hidden?: boolean }
export interface SiteInfo {
  title: string;
  description: string;
  brand: string;
  locales: string[];
  canonicalLocale: string | null;
  icons: SiteIcon[];
  /** Canonical deployment URL projected by the server. Never derive it from the Admin request origin. */
  publicUrl: string;
  /** Remote MCP endpoints actually mounted by this host. */
  mcpEndpoints?: { public: string | null; admin: string | null };
  /** Deprecated admin endpoint alias. */
  mcpUrl: string | null;
  /** What the deployment turned on; absent from an older server, which means all of it. */
  capabilities?: { siteSettings: boolean; media: boolean; invitationEmail: boolean; statistics: boolean };
  media?: {
    purposes?: MediaPurposePolicy[];
  };
}

export interface SiteIcon {
  src: string;
  mimeType?: string;
  sizes?: string[];
  theme?: "light" | "dark";
}

export interface MediaPurposePolicy {
  name: string;
  required: string[];
  maxBytes: Record<string, number>;
}

export interface MediaAssetVariant {
  mimeType: string;
  publicUrl: string;
  storageKey?: string;
  byteSize?: number;
  role: "primary" | "alternate" | "fallback";
}

export interface CommittedMediaAsset {
  id: string;
  alt?: string;
  caption?: string;
  variants: MediaAssetVariant[];
}

/** Media API item with its primary variant lifted for list rendering. */
export interface MediaLibraryItem {
  id: string;
  variants: MediaAssetVariant[];
  primaryUrl: string | null;
  mime: string | null;
  byteSize: number | null;
  alt: string | null;
  caption: string | null;
  createdAt: number;
}

export interface MediaLibraryListResult {
  items: MediaLibraryItem[];
  next_cursor: string | null;
}

/** Admin-operable Procedure derived from the manifest. */
/** One row binding of an admin operation, from the sealed plan. */
export interface AdminOperationInteraction {
  collection: string;
  bind: Array<{ input: string; field: string }>;
  version?: string;
  mutates: boolean;
}

export interface AdminOperation {
  /** Necessary string and boolean literal predicates; does not authorize execution. */
  preconditions?: Array<{ field: string; values: Array<string | boolean> }>;
  name: string;
  title: LocalizedText | null;
  description: LocalizedText | null;
  input: JsonSchema;
  uiSchema: Record<string, unknown> | null;
  triggers: Array<"mcp" | "http">;
  /** References that expose this operation from collection row menus. */
  rowBindings: Array<{ collection: string; inputField: string; rowField: string }>;
  /**
   * How a row of each collection feeds the operation (ADR-0029): the
   * inputs it binds and, on the operation target, the input carrying the
   * version the person reviewed. The first one per collection applies.
   */
  interactions: AdminOperationInteraction[];
}

/** A admin View as `/admin/api/views-manifest` lists it: its declared input, and the outputs that read a Schema field unchanged. */
export interface ViewManifestInfo {
  name: string;
  title: LocalizedText | null;
  description: LocalizedText | null;
  input: JsonSchema | null;
  /** `searchFields` and `filterFields` are the outputs the View's search box and filters match (ADR-0032 decision 5). */
  list: { columns: string[]; searchFields: string[]; filterFields: string[] };
  columns: Record<string, { schema: string; field: string }>;
  /** `uiSchema.nav` of the View. */
  nav?: NavPlacement;
}

export interface DeveloperSchemaModel {
  name: string;
  title: LocalizedText;
  lifecycle: Lifecycle;
  localized: boolean;
  translates: { parent: string; on: string } | null;
  schema: JsonSchema;
  checks?: SqlLogicNode[];
  uniqueIndexes: string[][];
  indexes: string[][];
  searchableFields: string[];
  manifest: unknown;
}

/** A View is one SELECT as authored (ADR-0034); `params` is its declared input. */
export interface DeveloperViewQuery {
  kind: "sql";
  statement: string;
  params?: JsonSchema;
}

export interface DeveloperViewModel {
  name: string;
  title: LocalizedText | null;
  surface: "public" | "admin" | "internal";
  query: DeveloperViewQuery;
  authorization: unknown[];
  guard: string | null;
  manifest: unknown;
}

export type DeveloperAtomKind = "Schema" | "View" | "Procedure" | "Trigger";
export type DeveloperAudience = "public" | "members" | "admin" | "system" | "api-clients";
export type DeveloperTransport = "http" | "mcp" | "lifecycle" | "schedule";

/** An inline program's SQL as authored, or a registered code handler. */
export interface SqlLogicNode { kind: string; label: string; children: SqlLogicNode[]; column?: { name: string; relation?: string }; relation?: { name: string; alias?: string } }

export type DeveloperProcedureHandler =
  | { kind: "sql"; statement: string; flow?: Array<{ logic?: SqlLogicNode; index: number; operation: string; table: string | null; mode: "read" | "row" | "set"; reads: string[]; writes: string[]; returns: string[]; filter: string | null; cases: Array<{ field: string; branches: Array<{ condition: string; value: string }>; otherwise: string }> }>; hooks?: Array<{ trigger: string; procedure: string; schema: string; on: string[] }> }
  | { kind: "ref"; ref: string };

export interface DeveloperProcedureModel {
  name: string;
  title: LocalizedText | null;
  description: LocalizedText | null;
  audience: DeveloperAudience;
  input: JsonSchema;
  output: JsonSchema;
  authorization: unknown[];
  guard: string | null;
  handler: DeveloperProcedureHandler;
  manifest: unknown;
}

export type DeveloperTriggerSource =
  | { kind: "http"; method: string; path: string }
  | { kind: "mcp"; surface: "public" | "admin" }
  | { kind: "lifecycle"; schema: string; on: string[] }
  | { kind: "schedule"; cron: string; enabled?: boolean };

export interface DeveloperTriggerModel {
  name: string;
  target: string;
  audience: DeveloperAudience;
  source: DeveloperTriggerSource;
  manifest: unknown;
}

export type DeveloperRelationKind =
  | "translation-parent"
  | "schema-reference"
  | "view-source"
  | "authorization-guard"
  | "procedure-schema"
  | "trigger-target"
  | "lifecycle-source";

export interface DeveloperAtom {
  id: string;
  kind: DeveloperAtomKind;
  name: string;
  title: LocalizedText | null;
  description?: LocalizedText | null;
  audience?: DeveloperAudience;
  transport?: DeveloperTransport;
  input?: JsonSchema;
  handler?: DeveloperProcedureHandler;
}

export interface DeveloperAtomRelation {
  id: string;
  kind: DeveloperRelationKind;
  sourceId: string;
  targetId: string;
  pointer: string;
  value: string;
}

export interface DeveloperRunObservation {
  scheduleId: string; runId: string; attempt: number; scheduledAt: number; startedAt: number;
  finishedAt: number | null; status: "started" | "succeeded" | "failed";
  durationMs: number | null; errorSummary: string | null;
  counts: { scanned?: number; removed?: number } | null;
}

export interface DeveloperConsoleSnapshot {
  operations?: {
    schedules: Array<{ id: string; procedure: string; cron: string; enabled: boolean; registration: "not-observed" }>;
    ttlPolicies: Array<{ schema: string; field: string; expireAfterSeconds: number; sweepObservation: "unavailable" }>;
    observationAvailability: "available" | "unavailable";
    runs: DeveloperRunObservation[];
    latestRuns: DeveloperRunObservation[];
  };
  dataModel: {
    schemas: DeveloperSchemaModel[];
    views: DeveloperViewModel[];
  };
  logic: {
    triggers: DeveloperTriggerModel[];
    procedures: DeveloperProcedureModel[];
  };
  interfaces: {
    http: DeveloperHttpOperation[];
    callable: DeveloperCallableCapability[];
  };
  graph: {
    atoms: DeveloperAtom[];
    relations: DeveloperAtomRelation[];
  };
}

export interface DeveloperHttpOperation {
  kind: "view" | "procedure";
  name: string;
  target: string;
  method: string;
  path: string;
  audience: DeveloperAudience;
  title: string | null;
  description: string;
  input: JsonSchema;
  output: JsonSchema | null;
}

export interface DeveloperCallableCapability {
  kind: "view" | "procedure";
  name: string;
  target: string;
  surface: "public" | "admin";
  audience: DeveloperAudience;
  title: string | null;
  description: string;
  input: JsonSchema;
  output: JsonSchema | null;
  trigger: string | null;
}

export const PUBLISHING_STATUSES: SidebarStatus[] = ["draft", "published", "archived"];
