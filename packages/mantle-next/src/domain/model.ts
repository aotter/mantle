/** Generation consumes compiler-owned data; emitted application code executes native SQL only. */
import type { LoweredStatement, PlanLowered, RuntimePlan } from "@aotter/mantle/spec";

export type Target = "bun-sqlite" | "bun-postgres" | "cloudflare-d1" | "cloudflare-postgres";
/** One Schema's Store, as Core lowered it: `SELECT r.* FROM <schema> r` (caller and trusted) and the one-statement UPDATE. */
export interface StoreSource {
  readonly schema: string;
  /** `[authored name, SQL column, Mantle type, flags]` (kernel/store.ts: FILTER 1, WRITE 2, ORDER 4), in output order. */
  readonly cols: readonly (readonly [string, string, string, number])[];
  readonly read: { readonly caller: LoweredStatement; readonly trusted: LoweredStatement };
  readonly update?: { readonly caller: LoweredStatement; readonly trusted: LoweredStatement };
}
export interface GenerateInput {
  readonly target: Target;
  readonly plan: RuntimePlan;
  readonly lowered: PlanLowered;
  /** Compiler-resolved output names, supplied by infrastructure; dynamic outputs remain undefined. */
  readonly viewKeys: Readonly<Record<string, readonly string[] | undefined>>;
  readonly stores?: readonly StoreSource[];
}
export interface GenerateDiagnostic {
  readonly code: string;
  readonly path: string;
  readonly message: string;
}
export type GenerateResult =
  | { readonly ok: true; readonly files: Readonly<Record<string, string>> }
  | { readonly ok: false; readonly diagnostics: readonly GenerateDiagnostic[] };
