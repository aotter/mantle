/** Generation consumes compiler-owned data; emitted application code executes native SQL only. */
import type { AdminExtension, PlanLowered, RuntimePlan, LoweredStatement } from "../build/compiler.js";

export type Target = "bun-sqlite" | "bun-postgres" | "cloudflare-d1" | "cloudflare-postgres";
export interface GenerateInput {
  readonly target: Target;
  /** Select generated bindings for the optional Admin server package. */
  readonly admin?: boolean;
  readonly adminEntries?: Readonly<Record<string,unknown>>;
  /** Compiler-authorized native creation-statistics reads, selected only for Admin. */
  readonly adminPages?: Readonly<Record<string,{caller:AdminPage;trusted:AdminPage}>>;
  /** Build-time declarations used to check manifest UI bindings. */
  readonly adminExtensions?: readonly AdminExtension[];
  readonly site?: import("../build/compiler.js").SiteDefaults;
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

export interface AdminPage {
  readonly marker:string;
  readonly binds: LoweredStatement["binds"];
  readonly keys: number;
  readonly first: {prefix:string;extra:readonly number[]};
  readonly next?: {prefix:string;extra:readonly number[]};
  readonly tail: string;
  readonly eq: Readonly<Record<string,string>>;
  readonly search?:string;
}
