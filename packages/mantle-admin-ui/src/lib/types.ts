/** Human-facing copy as a plain string or locale map. */
export type LocalizedText = string | Readonly<Record<string, string>>;

export type Lifecycle = "publishing" | "editorial" | "operational";

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
  /** Schema properties carrying `x-mcp-hint: media-*`. Upload hosting
   *  is optional; this only marks which fields are media-shaped. */
  mediaFields?: Array<{ name: string; hint: string }>;
  /** Required scalar fields backed by a declared Schema index. */
  sortableFields?: string[];
  /** Primary Admin list filter declared at uiSchema.list.filterField. */
  filter?: { field: string; values: string[] } | null;
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
  default?: unknown;
  additionalProperties?: boolean | JsonSchema;
  /** Optional JSON Schema help text. */
  description?: LocalizedText;
  /** Optional JSON Schema field label. */
  title?: LocalizedText;
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

export interface EntryRow {
  id: string;
  collection: string;
  locale: string | null;
  status: string;
  version: number;
  title: unknown;
  updated_at: number;
  /** First 3 `required` schema properties (skipping the one used as
   *  the title), present only for `lifecycle: "operational"` collections. */
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
  origin: string;
  brand: string;
  locales: string[];
  canonicalLocale: string | null;
  faviconUrl?: string;
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
  triggers: Array<"mcp" | "http">;
  /** References that expose this operation from collection row menus. */
  rowBindings: Array<{ collection: string; inputField: string; rowField: string }>;
}

/** Read-only View projection exposed by the Admin API. */
export interface ViewManifestInfo {
  name: string;
  title: LocalizedText | null;
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
export const PUBLISHING_STATUSES: SidebarStatus[] = ["draft", "published", "archived"];
