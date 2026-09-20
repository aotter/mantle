import { AsyncLocalStorage } from "node:async_hooks";

export type DiagnosticPhase = "oauth" | "role" | "runtime" | "catalog" | "dispatcherBuild" | "dispatch";
export type CatalogSource = "not-reached" | "kv-hit" | "d1-miss" | "d1-repair" | "d1-kv-error" | "binding-absent";
export interface BindingDiagnostics {
  calls: number;
  failures: number;
  inFlight: number;
  maxInFlight: number;
  byteSamples: number;
  wallMs: number;
  bytes: number | null;
  bytesSource: "utf8" | "buffer" | "serialized-result" | "object-result" | "mixed" | null;
}
export interface RequestDiagnosticRecord {
  version: 1;
  requestId: string;
  surface: "health" | "catalog" | "view" | "procedure" | "admin" | "mcp" | "web" | "r2" | "setup";
  arrivalAt: number;
  simultaneousArrivals: number;
  status: number | null;
  outcome: "http-ok" | "denied" | "error";
  totalMs: number;
  rpcOutcome: "result" | "error" | "tool-error" | "notification" | "invalid-response" | null;
  phases: Record<DiagnosticPhase, number | null>;
  catalog: { source: CatalogSource; sharedWait: boolean; waitMs: number | null; bootPublications: number };
  d1: null | {
    bindingCalls: number; statements: number; unknownStatementCalls: number; failures: number; inFlight: number; maxInFlight: number;
    /** Sums of available metadata; check coverage before treating them as totals. */
    wallMs: number; metadataStatements: number; durationMs: number | null;
    rowsRead: number | null; rowsWritten: number | null; resultBytes: number | null;
  };
  kv: null | Record<"get" | "put" | "delete" | "list", BindingDiagnostics>;
  r2: null | Record<"head" | "get" | "put" | "delete" | "list", BindingDiagnostics>;
}

// Only the testing entry point opens this context. Ordinary production requests
// have no record, clock reads, binding wrappers, observer or diagnostic headers.
export const requestDiagnosticContext = new AsyncLocalStorage<RequestDiagnosticRecord>();

/** Capture the initiating request before any asynchronous or shared work. */
export function beginDiagnosticPhase(phase: DiagnosticPhase): () => void {
  const record = requestDiagnosticContext.getStore();
  if (!record) return noop;
  const started = performance.now();
  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    record.phases[phase] = (record.phases[phase] ?? 0) + performance.now() - started;
  };
}

export function diagnosticPhase<T>(phase: DiagnosticPhase, run: () => Promise<T>): Promise<T> {
  if (!requestDiagnosticContext.getStore()) return run();
  const stop = beginDiagnosticPhase(phase);
  try { return run().finally(stop); } catch (error) { stop(); throw error; }
}

function noop(): void {}
