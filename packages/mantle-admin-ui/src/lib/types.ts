export type Lifecycle = "simple" | "editorial" | "none";

export type ContentStatus =
  | "draft"
  | "review"
  | "approved"
  | "scheduled"
  | "published"
  | "archived";

export type SidebarStatus = "draft" | "review" | "published" | "archived";

export interface Collection {
  name: string;
  title: string;
  description: string | null;
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
  /** Schema properties carrying `x-mcp-hint: media-*`. Upload hosting
   *  is optional; this only marks which fields are media-shaped. */
  mediaFields?: Array<{ name: string; hint: string }>;
  localized?: boolean;
  translates?: { parent: string; on: string } | null;
  schema?: JsonSchema;
  uiSchema?: Record<string, unknown> | null;
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
  default?: unknown;
  additionalProperties?: boolean | JsonSchema;
  description?: string;
  "x-mantle-ref"?: string;
  "x-mcp-hint"?: string;
  [key: string]: unknown;
}

export interface EntryEditorCollection extends Collection {
  localized: boolean;
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
    parentValue: string | number | boolean;
  };
  entries: EntryEditorEntry[];
}

export interface EntryEditorPayload {
  collection: EntryEditorCollection;
  entry: EntryEditorEntry;
  related: RelatedEntrySection[];
}

export type StaffRole = "owner" | "editor" | "contributor";

export interface AdminUser {
  login: string | null;
  role: StaffRole | null;
  userId?: string;
}

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

export interface EntryRow {
  id: string;
  collection: string;
  locale: string | null;
  status: string;
  version: number;
  title: unknown;
  updated_at: number;
  /** First 3 `required` schema properties (skipping the one used as
   *  the title), present only for `lifecycle: "none"` collections. */
  data_preview?: Record<string, unknown>;
}

export interface ListEntriesResult {
  items: EntryRow[];
  next_cursor: string | null;
}

export interface SiteInfo {
  title: string;
  description: string;
  origin: string;
  brand: string;
  locales: string[];
  canonicalLocale: string | null;
  publicUrl: string;
  mcpUrl: string;
  media?: {
    purposes?: MediaPurposePolicy[];
  };
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

/** `GET /admin/api/operations` entry (#426) — a staff-operable
 *  Procedure derived from the manifest (some Trigger targets it via
 *  `source.kind: "mcp"` + `surface: "staff"`, or `source.kind: "http"`
 *  with a `ctx.staff` auth predicate). */
export interface StaffOperation {
  name: string;
  description: string | null;
  input: JsonSchema;
  triggers: Array<"mcp" | "http">;
}

/** `GET /admin/api/views-manifest` entry (#426) — a read-only View
 *  projection over a Schema. `params` is the View's declared
 *  parameter JSON Schema, or `null` when the View takes none. */
export interface ViewManifestInfo {
  name: string;
  from: string;
  params: JsonSchema | null;
  fields: string[] | null;
}

export const EDITORIAL_STATUSES: SidebarStatus[] = [
  "draft",
  "review",
  "published",
  "archived",
];
export const SIMPLE_STATUSES: SidebarStatus[] = ["draft", "published", "archived"];
