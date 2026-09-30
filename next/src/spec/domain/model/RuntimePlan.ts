/**
 * The sealed plan (ADR-0032 decision 5, ADR-0034): what the CLI compiles from the manifests and Core executes.
 * Every SQL source is already IR here, so no Worker parses SQL. Pure types and constants.
 */
import type { AuthorizationRequirements, JsonSchema, ProcedureMcpAnnotations, ProcedureTarget, TriggerSource } from "./ManifestGrammar.js";
import type { SqlNode, SqlPlan } from "./SqlIr.js";

export const RUNTIME_PLAN_VERSION = 6 as const;

/** A Schema as storage and Store see it. Keys of `fields` and `names` are lower case: SQL folds unquoted identifiers. */
export interface PlanSchema {
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
  readonly search?: readonly string[];
  readonly unique?: readonly (readonly string[])[];
  readonly indexes?: readonly (readonly string[])[];
}

export interface PlanView extends SqlPlan {
  /** input property -> Mantle type */
  readonly inputs: Readonly<Record<string, string>>;
  readonly input?: JsonSchema;
  readonly surface: "public" | "staff" | "internal";
  readonly requires?: AuthorizationRequirements;
}

export interface PlanProcedure {
  readonly input: JsonSchema;
  readonly output: JsonSchema;
  /** input property -> Mantle type, for an inline `sql` handler */
  readonly inputs: Readonly<Record<string, string>>;
  readonly requires?: AuthorizationRequirements;
  readonly target?: ProcedureTarget;
  readonly mcp?: ProcedureMcpAnnotations;
  readonly handler: { readonly ref: string } | { readonly sql: SqlPlan };
}

export interface PlanTrigger {
  readonly source: TriggerSource;
  readonly procedure: string;
}

export interface RuntimePlan {
  readonly version: typeof RUNTIME_PLAN_VERSION;
  /** SHA-256 of the plan without this field (`planFingerprint`). */
  readonly fingerprint: string;
  readonly schemas: Readonly<Record<string, PlanSchema>>;
  readonly views: Readonly<Record<string, PlanView>>;
  readonly procedures: Readonly<Record<string, PlanProcedure>>;
  readonly triggers: Readonly<Record<string, PlanTrigger>>;
}
