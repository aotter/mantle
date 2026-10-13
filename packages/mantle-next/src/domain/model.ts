/** Generation consumes compiler-owned data; emitted application code executes native SQL only. */
import type { AdminExtension, PlanLowered, RuntimePlan } from "@aotter/mantle/compiler";

export type Target = "bun-sqlite" | "bun-postgres" | "cloudflare-d1" | "cloudflare-postgres";
export interface GenerateInput {
  readonly target: Target;
  /** Build-time declarations used to check manifest UI bindings. */
  readonly adminExtensions?: readonly Pick<AdminExtension, "id" | "contributes">[];
  readonly site?: import("@aotter/mantle/compiler").SiteDefaults;
  readonly plan: RuntimePlan;
  readonly lowered: PlanLowered;
  /** Compiler-resolved output names, supplied by infrastructure; dynamic outputs remain undefined. */
  readonly viewKeys: Readonly<Record<string, readonly string[] | undefined>>;
  /** Core's new entry id for this dialect, as an SQL expression (its `lowering.newId()`, printed). */
  readonly newId: string;
  /** Generation-time proofs for the canonical policy SELECT's complete cursor tuple. */
  readonly paging?: Readonly<Record<string, import("./paging.js").PagingProof | undefined>>;
}
export interface GenerateDiagnostic {
  readonly code: string;
  readonly path: string;
  readonly message: string;
}
export type GenerateResult =
  | { readonly ok: true; readonly files: Readonly<Record<string, string>>; readonly refProcedures: readonly string[] }
  | { readonly ok: false; readonly diagnostics: readonly GenerateDiagnostic[] };
