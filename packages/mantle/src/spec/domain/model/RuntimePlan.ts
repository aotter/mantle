/**
 * The sealed plan (ADR-0032 decision 5, ADR-0034): what the CLI compiles from the manifests and Core executes.
 * Every SQL source is already IR here, so no Worker parses SQL. Pure types and constants.
 */
import type { AuthorizationRequirements, JsonSchema, LocalizedText, ProcedureMcpAnnotations, ProcedureTarget, TriggerSource } from "./ManifestGrammar.js";
import type { SqlNode, SqlPlan } from "./SqlIr.js";

export const RUNTIME_PLAN_VERSION = 6 as const;

/** A Schema as storage and Store see it. Keys of `fields` and `names` are lower case: SQL folds unquoted identifiers. */
export interface PlanSchema {
  /** The name as declared: the key of `schemas` is lower case. */
  readonly name: string;
  readonly title?: LocalizedText;
  readonly description?: LocalizedText;
  /** Admin-only presentation, opaque to Core. */
  readonly uiSchema?: Readonly<Record<string, unknown>>;
  readonly localized?: boolean;
  readonly scope?: string;
  readonly ttl?: string;
  readonly ttlSeconds?: number;
  readonly publishing?: boolean;
  /** column -> Mantle type: text integer real bool json timestamptz date numeric(p,s) geo */
  readonly fields: Readonly<Record<string, string>>;
  /** lower-cased column -> the name the JSON Schema declares */
  readonly names: Readonly<Record<string, string>>;
  /** The Schema's JSON Schema: Store validates the values of a write against it. */
  readonly schema: JsonSchema;
  /** Boolean expressions over the row's own columns, as IR. */
  readonly checks?: readonly SqlNode[];
  /** A translation publishes only once the parent entry that shares `on` is published (ADR-0010). Names as declared. */
  readonly translates?: { readonly parent: string; readonly on: string };
  readonly search?: readonly string[];
  readonly unique?: readonly (readonly string[])[];
  readonly indexes?: readonly (readonly string[])[];
}

export interface PlanView extends SqlPlan {
  readonly title?: LocalizedText;
  readonly description?: LocalizedText;
  readonly uiSchema?: Readonly<Record<string, unknown>>;
  /** input property -> Mantle type */
  readonly inputs: Readonly<Record<string, string>>;
  readonly input?: JsonSchema;
  /** The SQL as authored, which Admin shows; the IR (`stmts`) is what runs. */
  readonly source: string;
  readonly surface: "public" | "staff" | "internal";
  readonly requires?: AuthorizationRequirements;
  /** `spec.cache.sharedMaxAge`: REST lets a shared cache keep an anonymous read this many seconds. Only an unguarded public View has it. */
  readonly sharedMaxAge?: number;
  /** Output name -> the Schema field it reads unchanged (`SELECT t.f`, `t.f AS f`, `*`, `created_at`) or a `sum`/`min`/`max` of it; the Store decodes these as `select` does. */
  readonly columns?: Readonly<Record<string, { readonly schema: string; readonly field: string }>>;
}

export interface PlanProcedure {
  readonly title?: LocalizedText;
  readonly description?: LocalizedText;
  readonly uiSchema?: Readonly<Record<string, unknown>>;
  readonly input: JsonSchema;
  readonly output: JsonSchema;
  /** input property -> Mantle type, for an inline `sql` handler */
  readonly inputs: Readonly<Record<string, string>>;
  readonly requires?: AuthorizationRequirements;
  readonly target?: ProcedureTarget;
  readonly mcp?: ProcedureMcpAnnotations;
  /** An inline handler carries its SQL as authored (`source`), which Admin shows; the IR is what runs. */
  readonly handler: { readonly ref: string } | { readonly sql: SqlPlan; readonly source: string };
}

export interface PlanTrigger {
  readonly source: TriggerSource;
  readonly procedure: string;
}

/** A statement as the dialect printed it at `mantle generate` (ADR-0044). Binds are Core's BindSpec as JSON. */
export interface LoweredStatement {
  readonly sql: string;
  readonly binds: readonly { readonly k: string; readonly [key: string]: unknown }[];
  readonly kind: "read" | "row" | "set";
  readonly schema?: string;
  readonly verb?: "insert" | "update" | "delete";
  /** Omitted when false. */
  readonly hooked?: true;
  /** Omitted when false. */
  readonly publish?: true;
  /** The policy AST has a RETURNING clause. */
  readonly returns?: true;
  /** A write's table, lower case (D1's unique-conflict op mapping). */
  readonly target?: string;
}

/** A paged statement of a View under one request shape, printed. The page size is a bind (`limit`), so one statement serves every page size. */
export interface LoweredPage {
  readonly sql: string;
  /** Where each extra bind comes from on a request, after the View's own binds: a cursor key, the search pattern, an equality value or the page size + 1. */
  readonly sources: readonly ({ readonly cursor: number } | { readonly search: true } | { readonly eq: number } | { readonly limit: true })[];
  readonly flat?: true;
  readonly names: readonly string[];
  readonly nkeys: number;
}

export interface LoweredView extends LoweredStatement {
  /** The length of the policy AST's sort clause. */
  readonly nkeys: number;
  /** By Core's page shape key (`pageShape`): no cursor, and a cursor whose every key is non-null. */
  readonly paged: Readonly<Record<string, LoweredPage>>;
}

export type LoweredMode = "caller" | "public" | "trusted";

/** What `mantle generate` printed for the plan's dialect (ADR-0044): text, bind recipes and paging metadata, never ASTs. */
export interface PlanLowered {
  /** The `@aotter/mantle` version that lowered. */
  readonly mantle: string;
  /** The dialect's name and version, and its `lowerKey` ("" when absent): a runtime on another uses none of it. */
  readonly dialect: { readonly name: string; readonly version: string; readonly key: string };
  readonly views: Readonly<Record<string, Readonly<Partial<Record<LoweredMode, LoweredView>>>>>;
  readonly procedures: Readonly<Record<string, Readonly<Partial<Record<"caller" | "trusted", readonly LoweredStatement[]>>>>>;
}

export interface RuntimePlan {
  readonly version: typeof RUNTIME_PLAN_VERSION;
  /** The dialect the SQL was compiled for (ADR-0035 decision 5); boot refuses a storage of another. */
  readonly dialect: { readonly name: string; readonly version: string };
  /** SHA-256 of the plan without this field (`planFingerprint`). */
  readonly fingerprint: string;
  readonly schemas: Readonly<Record<string, PlanSchema>>;
  readonly views: Readonly<Record<string, PlanView>>;
  readonly procedures: Readonly<Record<string, PlanProcedure>>;
  readonly triggers: Readonly<Record<string, PlanTrigger>>;
  /** Optional, covered by the fingerprint, and ignored by a runtime it does not match (ADR-0044). */
  readonly lowered?: PlanLowered;
}

/** The native columns a View may output that decode like a field of this type: the entry's timestamps. */
export const NATIVE_OUTPUT_TYPES: Readonly<Record<string, string>> = { created_at: "timestamptz", updated_at: "timestamptz" };
