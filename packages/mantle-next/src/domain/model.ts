/** Generation consumes compiler-owned data; emitted application code executes native SQL only. */
import type { LoweredStatement, PlanLowered, RuntimePlan } from "@aotter/mantle/spec";

export type Target = "bun-sqlite" | "bun-postgres" | "cloudflare-d1" | "cloudflare-postgres";
export interface GenerateInput {
  readonly target: Target;
  readonly plan: RuntimePlan;
  readonly lowered: PlanLowered;
  /** Compiler-resolved output names, supplied by infrastructure; dynamic outputs remain undefined. */
  readonly viewKeys: Readonly<Record<string, readonly string[] | undefined>>;
  /** Core's new entry id for this dialect, as an SQL expression (its `lowering.newId()`, printed). */
  readonly newId: string;
}
export interface GenerateDiagnostic {
  readonly code: string;
  readonly path: string;
  readonly message: string;
}
export type GenerateResult =
  | { readonly ok: true; readonly files: Readonly<Record<string, string>> }
  | { readonly ok: false; readonly diagnostics: readonly GenerateDiagnostic[] };
