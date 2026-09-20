/** Test/performance instrumentation. Never adds response headers or logs data. */
import {
  requestDiagnosticContext,
  type BindingDiagnostics,
  type RequestDiagnosticRecord,
} from "./requestDiagnostics.js";
export type { RequestDiagnosticRecord } from "./requestDiagnostics.js";

const active = new Set<RequestDiagnosticRecord>();
const wrappedBindings = new WeakMap<object, object>();
const nativeStatements = new WeakMap<object, object>();
const readBodies = new WeakMap<ReadableStream, { metric: BindingDiagnostics; consumed: boolean }>();

export function runWithRequestDiagnostics(
  options: {
    surface: RequestDiagnosticRecord["surface"];
    bindings: { d1?: boolean; kv?: boolean; r2?: boolean };
  },
  run: () => Promise<Response>,
  observe: (record: RequestDiagnosticRecord) => void | Promise<void>,
): Promise<Response> {
  const operation = (): BindingDiagnostics => ({ calls: 0, failures: 0, inFlight: 0, maxInFlight: 0, byteSamples: 0, wallMs: 0, bytes: null, bytesSource: null });
  const record: RequestDiagnosticRecord = {
    version: 1, requestId: crypto.randomUUID(), surface: options.surface,
    arrivalAt: Date.now(), simultaneousArrivals: active.size + 1,
    status: null, outcome: "error", totalMs: 0, rpcOutcome: null,
    phases: { oauth: null, role: null, runtime: null, catalog: null, dispatcherBuild: null, dispatch: null },
    catalog: { source: "not-reached", sharedWait: false, waitMs: null, bootPublications: 0 },
    d1: options.bindings.d1 ? { bindingCalls: 0, statements: 0, unknownStatementCalls: 0, failures: 0, inFlight: 0, maxInFlight: 0,
      wallMs: 0, metadataStatements: 0, durationMs: null, rowsRead: null, rowsWritten: null, resultBytes: null } : null,
    kv: options.bindings.kv ? { get: operation(), put: operation(), delete: operation(), list: operation() } : null,
    r2: options.bindings.r2 ? { head: operation(), get: operation(), put: operation(), delete: operation(), list: operation() } : null,
  };
  active.add(record);
  for (const current of active) current.simultaneousArrivals = Math.max(current.simultaneousArrivals, active.size);
  const started = performance.now();
  let responseCreatedAt: number | undefined;
  let observation: RequestDiagnosticRecord | undefined;
  return requestDiagnosticContext.run(record, async () => {
    try {
      const response = await run();
      responseCreatedAt = performance.now();
      active.delete(record);
      record.status = response.status;
      record.outcome = response.status === 401 || response.status === 403 ? "denied" : response.status >= 400 ? "error" : "http-ok";
      record.totalMs = responseCreatedAt - started;
      observation = structuredClone(record);
      if (options.surface === "mcp") {
        if (!response.body) observation.rpcOutcome = "notification";
        else {
          try {
            const rpc: unknown = await response.clone().json();
            observation.rpcOutcome = !isRecord(rpc) ? "invalid-response" : "error" in rpc ? "error"
              : "result" in rpc ? isRecord(rpc.result) && rpc.result.isError === true ? "tool-error" : "result" : "invalid-response";
          } catch { observation.rpcOutcome = "invalid-response"; }
        }
      }
      return response;
    } finally {
      record.totalMs = (responseCreatedAt ?? performance.now()) - started;
      active.delete(record);
      // Deferred I/O can complete later. Publish an immutable observation of
      // response-creation time; inFlight/metadata coverage expose partial data.
      try {
        const pending = observe(observation ?? structuredClone(record));
        if (pending) void pending.catch(() => {});
      } catch { /* Observers cannot change an outcome. */ }
    }
  });
}

/** Wrap before passing this same binding to Auth and D1DatabaseDriver. */
export function instrumentD1(db: D1Database): D1Database {
  return wrapDatabase(db);
}

function wrapDatabase<T extends object>(db: T): T {
  return cachedProxy(db, (target, key) => {
    const method = Reflect.get(target, key);
    if (typeof method !== "function") return method;
    if (key === "prepare") return (...args: unknown[]) => wrapStatement(Reflect.apply(method, target, args));
    if (key === "withSession") return (...args: unknown[]) => wrapDatabase(Reflect.apply(method, target, args));
    if (key === "batch") return (statements: object[]) => d1Call(statements.length, false,
      () => Reflect.apply(method, target, [statements.map((stmt) => nativeStatements.get(stmt) ?? stmt)]));
    if (key === "exec" || key === "dump") return (...args: unknown[]) => d1Call(0, true, () => Reflect.apply(method, target, args));
    return method.bind(target);
  });
}

function wrapStatement<T extends object>(statement: T): T {
  const proxy = cachedProxy(statement, (target, key) => {
    const method = Reflect.get(target, key);
    if (typeof method !== "function") return method;
    if (key === "bind") return (...args: unknown[]) => wrapStatement(Reflect.apply(method, target, args));
    if (["all", "first", "raw", "run"].includes(String(key))) {
      return (...args: unknown[]) => d1Call(1, false, () => Reflect.apply(method, target, args));
    }
    return method.bind(target);
  });
  nativeStatements.set(proxy, statement);
  return proxy;
}

async function d1Call<T>(statements: number, unknownStatements: boolean, run: () => T | Promise<T>): Promise<T> {
  const metric = requestDiagnosticContext.getStore()?.d1;
  if (!metric) return run();
  const started = performance.now();
  metric.bindingCalls++;
  metric.statements += statements;
  metric.inFlight++;
  metric.maxInFlight = Math.max(metric.maxInFlight, metric.inFlight);
  if (unknownStatements) metric.unknownStatementCalls++;
  try {
    const result = await run();
    try {
      if (unknownStatements && isRecord(result) && finite(result.count)) {
        metric.statements += result.count;
        metric.unknownStatementCalls--;
        if (finite(result.duration)) metric.durationMs = (metric.durationMs ?? 0) + result.duration;
      }
      const items = Array.isArray(result) ? result : [result];
      if (items.some((item) => isRecord(item) && item.success === false)) metric.failures++;
      for (const item of items) {
        if (!isRecord(item) || !isRecord(item.meta)) continue;
        const meta = item.meta;
        if ([meta.rows_read, meta.rows_written, meta.duration].some(finite)) metric.metadataStatements++;
        if (finite(meta.rows_read)) metric.rowsRead = (metric.rowsRead ?? 0) + meta.rows_read;
        if (finite(meta.rows_written)) metric.rowsWritten = (metric.rowsWritten ?? 0) + meta.rows_written;
        if (finite(meta.duration)) metric.durationMs = (metric.durationMs ?? 0) + meta.duration;
      }
      const size = valueBytes(result);
      if (size) metric.resultBytes = (metric.resultBytes ?? 0) + size.bytes;
    } catch { /* Metric inspection is observational. */ }
    return result;
  } catch (error) {
    metric.failures++;
    throw error;
  } finally {
    metric.inFlight--;
    metric.wallMs += performance.now() - started;
  }
}

export function instrumentKv(namespace: KVNamespace): KVNamespace {
  return cachedProxy(namespace, (target, key) => {
    const method = Reflect.get(target, key);
    if (typeof method !== "function") return method;
    const operation = key === "getWithMetadata" ? "get" : key;
    if (!["get", "put", "delete", "list"].includes(String(operation))) return method.bind(target);
    return async (...args: unknown[]) => {
      const metric = requestDiagnosticContext.getStore()?.kv?.[operation as keyof NonNullable<RequestDiagnosticRecord["kv"]>];
      return bindingCall(metric, () => Reflect.apply(method, target, args), (result) => {
        if (operation === "delete") return { bytes: 0, source: "utf8" };
        return valueBytes(operation === "put" ? args[1] : key === "getWithMetadata" && isRecord(result) ? result.value : result);
      });
    };
  });
}

/** Payload bytes only; unconsumed/partially consumed GET bodies remain unknown.
 * A successful PUT of the exact GET stream confirms both transfers without
 * wrapping the stream (R2 needs its native known-length property). */
export function instrumentR2(bucket: R2Bucket): R2Bucket {
  return cachedProxy(bucket, (target, key) => {
    const method = Reflect.get(target, key);
    if (typeof method !== "function") return method;
    if (!["head", "get", "put", "delete", "list"].includes(String(key))) return method.bind(target);
    return async (...args: unknown[]) => {
      const metric = requestDiagnosticContext.getStore()?.r2?.[key as keyof NonNullable<RequestDiagnosticRecord["r2"]>];
      return bindingCall(metric, () => Reflect.apply(method, target, args), (result) => {
        if (key === "get" && isRecord(result) && result.body instanceof ReadableStream) {
          if (metric) readBodies.set(result.body, { metric, consumed: false });
          return null;
        }
        if (key === "put" && isRecord(result) && finite(result.size)) {
          const source = args[1] instanceof ReadableStream ? readBodies.get(args[1]) : undefined;
          if (source && !source.consumed) {
            source.consumed = true;
            addBytes(source.metric, { bytes: result.size, source: "object-result" });
          }
          return { bytes: result.size, source: "object-result" };
        }
        if (key === "head" || key === "delete" || (key === "get" && result === null)) return { bytes: 0, source: "object-result" };
        return key === "list" ? valueBytes(result) : null;
      });
    };
  });
}

async function bindingCall<T>(
  metric: BindingDiagnostics | null | undefined,
  run: () => T | Promise<T>,
  payload: (result: T) => { bytes: number; source: NonNullable<BindingDiagnostics["bytesSource"]> } | null,
): Promise<T> {
  if (!metric) return run();
  const started = performance.now();
  metric.calls++;
  metric.inFlight++;
  metric.maxInFlight = Math.max(metric.maxInFlight, metric.inFlight);
  try {
    const result = await run();
    try { addBytes(metric, payload(result)); } catch { /* Metric inspection is observational. */ }
    return result;
  } catch (error) {
    metric.failures++;
    throw error;
  } finally {
    metric.inFlight--;
    metric.wallMs += performance.now() - started;
  }
}

function addBytes(metric: BindingDiagnostics, size: ReturnType<typeof valueBytes>): void {
  if (!size) return;
  metric.bytes = (metric.bytes ?? 0) + size.bytes;
  metric.byteSamples++;
  metric.bytesSource = metric.bytesSource && metric.bytesSource !== size.source ? "mixed" : size.source;
}

function valueBytes(value: unknown): { bytes: number; source: NonNullable<BindingDiagnostics["bytesSource"]> } | null {
  if (value === null || value === undefined) return { bytes: 0, source: "utf8" };
  if (value instanceof ArrayBuffer) return { bytes: value.byteLength, source: "buffer" };
  if (ArrayBuffer.isView(value)) return { bytes: value.byteLength, source: "buffer" };
  if (value instanceof ReadableStream) return null;
  if (typeof value === "string") return { bytes: new TextEncoder().encode(value).byteLength, source: "utf8" };
  try { return { bytes: new TextEncoder().encode(JSON.stringify(value)).byteLength, source: "serialized-result" }; }
  catch { return null; }
}

function cachedProxy<T extends object>(target: T, get: ProxyHandler<T>["get"]): T {
  const known = wrappedBindings.get(target);
  if (known) return known as T;
  const proxy = new Proxy(target, { get });
  wrappedBindings.set(target, proxy);
  wrappedBindings.set(proxy, proxy);
  return proxy;
}
function finite(value: unknown): value is number { return typeof value === "number" && Number.isFinite(value) && value >= 0; }
function isRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object"; }
