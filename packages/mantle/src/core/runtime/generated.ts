/** Generated application code, registered by exact plan identity (ADR-0045). */
import type { RuntimePlan } from "../../spec/domain/index.js";
import type { MantleDialect, StoreCodec } from "../dialect.js";
import type { StoreRow } from "../store.js";
import type { BindContext } from "../sql/compile.js";
import type { Mode } from "../sql/policy.js";
import { MANTLE_VERSION } from "../version.js";

export type GeneratedRow = (row: StoreRow, codec: StoreCodec) => StoreRow;
export type GeneratedBinder = (context: BindContext, extra: { version?: unknown; cursor?: readonly unknown[] }, dialect: MantleDialect) => unknown[];
type ProgramBinders = Readonly<Record<string, Readonly<Partial<Record<Mode, readonly GeneratedBinder[]>>>>>;
type InputProjectors = Readonly<Record<string, (input: unknown) => Readonly<Record<string, unknown>> | undefined>>;
export interface GeneratedRuntime {
  readonly fingerprint: string;
  readonly mantle: string;
  readonly dialect: { readonly name: string; readonly version: string; readonly key: string };
  readonly viewRows?: Readonly<Record<string, GeneratedRow>>;
  readonly binders?: Readonly<Partial<Record<"view" | "procedure", ProgramBinders>>>;
  readonly inputs?: Readonly<Partial<Record<"view" | "procedure", InputProjectors>>>;
}

const registered = new WeakMap<RuntimePlan, GeneratedRuntime>();
export type GeneratedStatus = "used" | "absent" | "uploaded" | "restricted" | "unsupported" | "fingerprint" | "mantle-version" | "dialect";

/** Only bundled application code can register functions; JSON plans cannot. No plan work runs here. */
export function registerGenerated(plan: RuntimePlan, generated: GeneratedRuntime): void {
  registered.set(plan, generated);
}

/** Acquired per runtime, never attached to shared compiled entries. Uploaded/restricted runtimes retain their ordinary paths. */
export function generatedFor(plan: RuntimePlan, dialect: MantleDialect, expectedFingerprint?: string): GeneratedRuntime | undefined {
  return generatedStatus(plan, dialect, expectedFingerprint) === "used" ? registered.get(plan) : undefined;
}

export function generatedStatus(plan: RuntimePlan, dialect: MantleDialect, expectedFingerprint?: string): GeneratedStatus {
  if (expectedFingerprint !== undefined) return "uploaded";
  if (dialect.restricted) return "restricted";
  if (!dialect.print) return "unsupported";
  const g = registered.get(plan);
  if (!g) return "absent";
  if (g.fingerprint !== plan.fingerprint) return "fingerprint";
  if (g.mantle !== MANTLE_VERSION) return "mantle-version";
  if (g.dialect.name !== dialect.name || g.dialect.version !== dialect.version || g.dialect.key !== (dialect.lowerKey ?? "")) return "dialect";
  return "used";
}
