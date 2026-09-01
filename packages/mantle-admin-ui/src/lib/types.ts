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
  /** Primary Admin list filter declared at uiSchema.list.filterField. */
  filter?: { field: string; values: string[] } | null;
  /** Operational list data fields resolved from uiSchema.list. */
  list?: { primaryField: string | null; columns: string[] };
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
  "x-mantle-ref"?: string;
  "x-mcp-hint"?: string;
  [key: string]: unknown;
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
  status: ContentStatus;
  version: number;
  data: Record<string, unknown>;
  updated_at: number;
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

export interface EntryEditorPayload {
  collection: EntryEditorCollection;
  entry: EntryEditorEntry;
  parentEntryId: string | null;
  related: RelatedEntrySection[];
}

export type StaffRole = "owner" | "editor" | "contributor";

export interface AdminUser {
  login: string | null;
  image: string | null;
  role: StaffRole | null;
  userId?: string;
}

/** Public sign-in capabilities returned by `GET /api/auth/methods`. */
export type AuthMethodInfo =
  | { kind: "email-otp" }
  | { kind: "magic-link" }
  | { kind: "social"; provider: string }
  | { kind: "oauth"; providerId: string; displayName?: string };

/** Row from `GET /admin/api/staff` (owner-only). `createdAt` arrives
 *  as an ISO string over the wire. `emailVerified: false` with no
 *  `githubLogin` marks a pending invitation nobody has signed in to. */
export interface StaffUser {
  id: string;
  email: string;
  name: string;
  role: string | null;
  githubLogin: string | null;
  emailVerified: boolean;
  createdAt: string;
}

export interface MemberUser {
  id: string;
  email: string;
  name: string;
  emailVerified: boolean;
  createdAt: string;
}

export interface MemberListResult {
  items: MemberUser[];
  previous_cursor: string | null;
  next_cursor: string | null;
}

export interface EntryRow {
  id: string;
  collection: string;
  locale: string | null;
  status: string;
  version: number;
  title: unknown;
  updated_at: number;
  translation_locales: string[];
  /** Explicit uiSchema.list data fields for operational collections. */
  data_preview?: Record<string, unknown>;
}

export interface ListEntriesResult {
  items: EntryRow[];
  previous_cursor: string | null;
  next_cursor: string | null;
}

export interface SiteInfo {
  title: string;
  description: string;
  brand: string;
  locales: string[];
  canonicalLocale: string | null;
  icons: SiteIcon[];
  /** Canonical deployment URL projected by the server. Never derive it from the Admin request origin. */
  publicUrl: string;
  mcpUrl: string;
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

/** Staff-operable Procedure derived from the manifest. */
export interface StaffOperation {
  name: string;
  title: LocalizedText | null;
  description: LocalizedText | null;
  input: JsonSchema;
  uiSchema: Record<string, unknown> | null;
  triggers: Array<"mcp" | "http">;
  /** References that expose this operation from collection row menus. */
  rowBindings: Array<{ collection: string; inputField: string; rowField: string }>;
}

/** Read-only View projection exposed by the Admin API. */
export interface ViewManifestInfo {
  name: string;
  title: LocalizedText | null;
  from: string | null;
  params: JsonSchema | null;
  fields: string[] | null;
  list: { columns: string[]; searchFields: string[]; filterFields: string[] };
}

export interface DeveloperSchemaModel {
  name: string;
  title: LocalizedText;
  lifecycle: Lifecycle;
  localized: boolean;
  translates: { parent: string; on: string } | null;
  schema: JsonSchema;
  uniqueIndexes: string[][];
  indexes: string[][];
  searchableFields: string[];
  manifest: unknown;
}

export type DeveloperViewQuery =
  | {
      kind: "declarative";
      from: string;
      fields?: string[];
      filter?: unknown;
      orderBy: Array<{ field: string; direction: "asc" | "desc" }>;
      limit?: number;
      params?: JsonSchema;
    }
  | {
      kind: "native";
      dialect: "sqlite";
      statement: string;
      limit?: number;
      params?: JsonSchema;
    };

export interface DeveloperViewModel {
  name: string;
  title: LocalizedText | null;
  surface: "public" | "staff";
  query: DeveloperViewQuery;
  authorization: unknown[];
  guard: string | null;
  manifest: unknown;
}

export type DeveloperAtomKind = "Schema" | "View" | "Procedure" | "Trigger";
export type DeveloperAudience = "public" | "members" | "staff" | "system" | "api-clients";
export type DeveloperTransport = "http" | "mcp" | "lifecycle";

export type DeveloperProcedureHandler =
  | { kind: "builtin"; op: "create" | "update" | "upsert" | "delete" | "archive"; schema: string; match?: readonly string[] }
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
  | { kind: "mcp"; surface: "public" | "staff" }
  | { kind: "lifecycle"; schema: string; on: string[]; errorPolicy?: string };

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
  | "collection-action"
  | "input-reference"
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

export interface DeveloperConsoleSnapshot {
  dataModel: {
    schemas: DeveloperSchemaModel[];
    views: DeveloperViewModel[];
  };
  logic: {
    triggers: DeveloperTriggerModel[];
    procedures: DeveloperProcedureModel[];
  };
  graph: {
    atoms: DeveloperAtom[];
    relations: DeveloperAtomRelation[];
  };
}

export const PUBLISHING_STATUSES: SidebarStatus[] = ["draft", "published", "archived"];
