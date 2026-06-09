export type Lifecycle = "simple" | "editorial";

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

export interface AdminUser {
  login: string | null;
  role: "owner" | "editor" | "contributor" | null;
  userId?: string;
}

export interface EntryRow {
  id: string;
  collection: string;
  locale: string | null;
  status: string;
  version: number;
  title: unknown;
  updated_at: number;
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
}

export interface SiteSettings {
  brand: string;
  title: string;
  description: string;
  brandIntro: string;
  serviceIncludes: string;
  currency: string;
  paymentProvider: string;
  paymentMerchantId: string;
  checkoutReturnPath: string;
  checkoutCallbackPath: string;
  checkoutTermsUrl: string;
  ga4MeasurementId: string;
  facebookPixelId: string;
}

export interface DeveloperLogItem {
  id: string;
  source: "llm" | "tui" | "agent" | "manual" | "system" | string;
  level: "info" | "warning" | "error" | "success" | string;
  message: string;
  details: string | null;
  actor: string | null;
  created_at: number;
}

export interface CoverageItem {
  kind: "Schema" | "View" | "Procedure" | "Trigger" | string;
  name: string;
  status: "covered" | "folded" | "api-only";
  href: string | null;
  method?: string;
  path?: string;
  note: string;
}

export interface CoverageReport {
  summary: {
    covered: number;
    folded: number;
    apiOnly: number;
    total: number;
  };
  items: CoverageItem[];
}

export interface AdminActionItem {
  name: string;
  input: JsonSchema;
  output: JsonSchema;
  requiresAuth: boolean;
  handlerKind: string;
  handlerRef?: string;
  description?: string;
  outputDescription?: string;
  operationKind?: "checkout" | "inventory" | "orders" | "system" | "generic" | string;
  audience?: "staff" | "storefront" | "system" | "agent" | string;
  manualRun?: "recommended" | "debug" | "advanced" | string;
  triggers?: AdminActionTrigger[];
}

export interface AdminActionsResult {
  items: AdminActionItem[];
}

export interface AdminActionTrigger {
  name: string;
  sourceKind: string;
  method?: string;
  path?: string;
  schema?: string;
  hooks?: string[];
  surface?: string;
}

export interface AdminActionRunResult {
  ok: true;
  data: unknown;
}

export interface AdminMediaVariant {
  mimeType: string;
  publicUrl: string;
  storageKey: string;
  byteSize: number;
  role: string;
}

export interface AdminMediaAsset {
  id: string;
  alt: string | null;
  caption: string | null;
  createdAt: number;
  ownerId: string | null;
  variants: AdminMediaVariant[];
  primaryUrl: string | null;
  primaryMimeType: string | null;
  totalBytes: number;
  metadata: Record<string, string> | null;
}

export interface ListMediaAssetsResult {
  items: AdminMediaAsset[];
  next_cursor: string | null;
}

export const EDITORIAL_STATUSES: SidebarStatus[] = [
  "draft",
  "review",
  "published",
  "archived",
];
export const SIMPLE_STATUSES: SidebarStatus[] = ["draft", "published", "archived"];
