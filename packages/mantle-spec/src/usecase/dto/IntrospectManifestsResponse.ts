import type {
  AdminActionAudience,
  AdminActionManualRunMode,
  AdminActionOperationKind,
  AuthPredicate,
  FilterAst,
  HandlerBinding,
  JsonSchema,
  TriggerSource,
} from "../../domain/model/ManifestGrammar.js";
import type { Diagnostic } from "../../kernel/diagnostic.js";

export interface IntrospectedSchema {
  readonly name: string;
  readonly title: string;
  readonly localized: boolean;
  readonly lifecycle: string;
  readonly translates: { readonly parent: string; readonly on: string } | null;
  readonly uniqueIndexes: ReadonlyArray<ReadonlyArray<string>>;
  readonly properties: ReadonlyArray<string>;
}

export interface IntrospectedView {
  readonly name: string;
  readonly from: string;
  readonly params: JsonSchema | null;
  readonly filter: FilterAst | null;
  readonly orderBy: ReadonlyArray<{ readonly field: string; readonly direction?: "asc" | "desc" }>;
  readonly fields: ReadonlyArray<string> | null;
  readonly limit: number | null;
  readonly restPath: string;
}

export interface IntrospectedProcedure {
  readonly name: string;
  readonly handler: HandlerBinding;
  readonly auth: { readonly all: ReadonlyArray<AuthPredicate> } | null;
  readonly input: JsonSchema;
  readonly output: JsonSchema;
}

export interface IntrospectedTrigger {
  readonly name: string;
  readonly source: TriggerSource;
  readonly target: { readonly procedure: string };
}

export interface IntrospectedAdminActionTrigger {
  readonly name: string;
  readonly sourceKind: string;
  readonly method?: string;
  readonly path?: string;
  readonly schema?: string;
  readonly hooks?: ReadonlyArray<string>;
  readonly surface?: string;
}

export interface IntrospectedAdminAction {
  readonly name: string;
  readonly input: JsonSchema;
  readonly output: JsonSchema;
  readonly requiresAuth: boolean;
  readonly handlerKind: string;
  readonly handlerRef?: string;
  readonly description?: string;
  readonly outputDescription?: string;
  readonly operationKind: AdminActionOperationKind;
  readonly audience: AdminActionAudience;
  readonly manualRun: AdminActionManualRunMode;
  readonly triggers: ReadonlyArray<IntrospectedAdminActionTrigger>;
}

export interface IntrospectManifestsResponse {
  readonly schemas: ReadonlyArray<IntrospectedSchema>;
  readonly views: ReadonlyArray<IntrospectedView>;
  readonly procedures: ReadonlyArray<IntrospectedProcedure>;
  readonly triggers: ReadonlyArray<IntrospectedTrigger>;
  readonly adminActions: ReadonlyArray<IntrospectedAdminAction>;
  readonly parseErrors: ReadonlyArray<Diagnostic>;
}
