/** Generation consumes compiler-owned data; emitted application code executes native SQL only. */
import type { AdminExtension, PlanLowered, RuntimePlan, LoweredStatement } from "../build/compiler.js";

import type { Target } from "./generation.js";
export type { Target, GenerateDiagnostic, GenerateResult } from "./generation.js";
export interface GenerateInput {
  readonly target: Target;
  /** Select generated bindings for the optional Admin server package. */
  readonly admin?: boolean;
  readonly adminEntries?: Readonly<Record<string,unknown>>;
  /** Compiler-authorized native creation-statistics reads, selected only for Admin. */
  readonly adminPages?: Readonly<Record<string,{caller:AdminPage;trusted:AdminPage}>>;
  /** Build-time declarations used to check manifest UI bindings. */
  readonly adminExtensions?: readonly AdminExtension[];
  /** Project sidebar groups; Schemas, admin Views and extension pages place items in them with `nav.group`. */
  readonly navGroups?: readonly import("../build/compiler.js").AdminNavGroup[];
  readonly site?: import("../build/compiler.js").SiteDefaults;
  readonly plan: RuntimePlan;
  readonly description: import("./describe/index.js").AppDescription;
  readonly lowered: PlanLowered;
  readonly wireLowered?: PlanLowered;
  /** Compiler-resolved output names, supplied by infrastructure; dynamic outputs remain undefined. */
  readonly viewKeys: Readonly<Record<string, readonly string[] | undefined>>;
  /** Core's new entry id for this dialect, as an SQL expression (its `lowering.newId()`, printed). */
  readonly newId: string;
  /** Generation-time proofs for the canonical policy SELECT's complete cursor tuple. */
  readonly paging?: Readonly<Record<string, import("./paging.js").PagingProof | undefined>>;
}
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
