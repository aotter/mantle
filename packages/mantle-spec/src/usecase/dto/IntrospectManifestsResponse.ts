import type {
  AuthPredicate,
  FilterAst,
  HandlerBinding,
  JsonSchema,
  LocalizedText,
  TriggerSource,
} from "../../domain/model/ManifestGrammar.js";
import type { Diagnostic } from "../../kernel/diagnostic.js";

export interface IntrospectedSchema {
  readonly name: string;
  /** Raw passthrough of `Schema.spec.title` (#430) — string or a
   *  locale-map `LocalizedText`; this CLI dump does no resolution. */
  readonly title: LocalizedText;
  readonly localized: boolean;
  readonly lifecycle: string;
  readonly translates: { readonly parent: string; readonly on: string } | null;
  readonly uniqueIndexes: ReadonlyArray<ReadonlyArray<string>>;
  readonly indexes: ReadonlyArray<ReadonlyArray<string>>;
  readonly searchableFields: readonly string[];
  readonly properties: ReadonlyArray<string>;
}

export interface IntrospectedView {
  readonly name: string;
  readonly from: string | null;
  readonly sql: string | null;
  readonly surface: "public" | "staff";
  readonly params: JsonSchema | null;
  readonly filter: FilterAst | null;
  readonly orderBy: ReadonlyArray<{ readonly field: string; readonly direction?: "asc" | "desc" }>;
  readonly fields: ReadonlyArray<string> | null;
  readonly limit: number | null;
  readonly restPath: string;
  readonly auth: { readonly all: ReadonlyArray<AuthPredicate> } | null;
  readonly guard: { readonly procedure: string } | null;
}

export interface IntrospectedProcedure {
  readonly name: string;
  readonly handler: HandlerBinding;
  readonly auth: { readonly all: ReadonlyArray<AuthPredicate> } | null;
  readonly guard: { readonly procedure: string } | null;
  readonly input: JsonSchema;
  readonly output: JsonSchema;
}

export interface IntrospectedTrigger {
  readonly name: string;
  readonly source: TriggerSource;
  readonly target: { readonly procedure: string };
}

export interface IntrospectManifestsResponse {
  readonly schemas: ReadonlyArray<IntrospectedSchema>;
  readonly views: ReadonlyArray<IntrospectedView>;
  readonly procedures: ReadonlyArray<IntrospectedProcedure>;
  readonly triggers: ReadonlyArray<IntrospectedTrigger>;
  readonly parseErrors: ReadonlyArray<Diagnostic>;
}
