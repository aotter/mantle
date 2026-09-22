import { describe, expect, it, vi } from "vitest";
import { createMantleWorker } from "../src/worker/createMantleWorker.js";
import { instrumentD1, instrumentKv, instrumentR2, runWithRequestDiagnostics, type RequestDiagnosticRecord } from "../src/testing.js";
import { D1DatabaseDriver } from "../src/bindings/D1DatabaseDriver.js";
import { compileTestPlan } from "./compileTestPlan.js";
import { sqliteD1 } from "./fakes/sqlite-d1.js";
import { stubAuth } from "./fakes/runtime-bindings.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
const options = { surface: "mcp", bindings: { d1: true, kv: true, r2: true } } as const;
const ctx = { waitUntil() {} } as unknown as ExecutionContext;

function fixture() {
  const { db: native, sqlite } = sqliteD1();
  const db = instrumentD1(native);
  const values = new Map<string, string>();
  let blocked: Promise<void> | undefined;
  let fail = false;
  let role = "owner";
  const namespace = instrumentKv({
    async get(key: string) { await blocked; if (fail) throw new Error("PRIVATE_KV_DETAIL"); return values.get(key) ?? null; },
    async put(key: string, value: string) { values.set(key, value); },
  } as unknown as KVNamespace);
  const worker = createMantleWorker({
    plan: compileTestPlan([]), siteDefaults: { title: "Fixture", brand: "Fixture", locales: ["en"] },
    cacheScope: "diagnostics-fixture",
    auth: () => ({ ...stubAuth,
      verifyOAuthAccessToken: async (request) => {
        // Deliberately deterministic auth, with native D1 I/O for attribution.
        // Real Better Auth, JWT and DPoP fixtures belong to the matched harness.
        await db.prepare("SELECT ? AS private").bind("PRIVATE_USER_ID").all();
        return request.headers.get("authorization") === "Bearer PRIVATE_TOKEN"
          ? { ok: true as const, userId: "PRIVATE_USER_ID", credentialId: "PRIVATE_GRANT", scopes: ["mcp"] }
          : { ok: false as const, status: 401 as const, reason: "invalid-token" };
      },
      getUserRole: async () => (await db.prepare("SELECT ? AS role").bind(role).first<{ role: string }>())!.role,
    }),
  });
  const env = { DB: db, MANTLE_KV: namespace };
  const request = (authorized = true) => new Request("https://example.test/mcp/staff", {
    // An invalid bearer, not an anonymous request: anonymous callers never reach
    // token verification, so the denied path under test must present a token.
    method: "POST", headers: { "content-type": "application/json", "mcp-protocol-version": "2025-11-25", authorization: authorized ? "Bearer PRIVATE_TOKEN" : "Bearer PRIVATE_WRONG" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  return { sqlite, db, values, worker, env, request,
    block(promise?: Promise<void>) { blocked = promise; }, fail(value: boolean) { fail = value; }, role(value: string) { role = value; } };
}

describe("request-local diagnostics", () => {
  it("attributes overlapping MCP auth and shared KV work to the initiating request", async () => {
    const h = fixture();
    try {
      await h.worker.getRuntime(h.env);
      const gate = deferred();
      h.block(gate.promise);
      let first: RequestDiagnosticRecord | undefined;
      let second: RequestDiagnosticRecord | undefined;
      const a = runWithRequestDiagnostics(options, () => h.worker.fetch(h.request(), h.env, ctx), (record) => { first = record; });
      const b = runWithRequestDiagnostics(options, () => h.worker.fetch(h.request(), h.env, ctx), (record) => { second = record; });
      // Native auth awaits settle before allowing the shared KV lookup to finish.
      await new Promise((done) => setTimeout(done, 10));
      gate.resolve();
      const responses = await Promise.all([a, b]);
      for (const response of responses) {
        expect(response.status).toBe(200);
        expect(response.headers.get("cache-control")).toBe("private, no-store");
        expect([...response.headers.keys()].some((key) => key.startsWith("x-mantle"))).toBe(false);
        expect(await response.json()).toMatchObject({ jsonrpc: "2.0", id: 1, result: { tools: expect.any(Array) } });
      }
      for (const record of [first!, second!]) {
        expect(record.d1).toMatchObject({ statements: 2, bindingCalls: 2, failures: 0, inFlight: 0 });
        expect(record.simultaneousArrivals).toBe(2);
        expect(Object.values(record.phases).every((value) => typeof value === "number")).toBe(true);
        expect(record.catalog.source).toBe("kv-hit");
        expect(record.outcome).toBe("http-ok");
        expect(record.rpcOutcome).toBe("result");
      }
      expect(first!.kv!.get.calls + second!.kv!.get.calls).toBe(1);
      const waiter = first!.catalog.sharedWait ? first! : second!;
      expect(waiter.catalog.waitMs).toBeGreaterThan(0);
      expect(waiter.kv!.get.calls).toBe(0);
      expect(first!.requestId).not.toBe(second!.requestId);
      expect(JSON.stringify([first, second])).not.toMatch(/PRIVATE_|SELECT|Bearer|authorization/);
      const saved = [...h.values.entries()];
      h.values.clear();
      h.block(undefined);
      h.sqlite.exec("DROP TABLE site_config");
      const errors = vi.spyOn(console, "error").mockImplementation(() => {});
      const failures: RequestDiagnosticRecord[] = [];
      const failed = await Promise.all([0, 1].map(() => runWithRequestDiagnostics(options,
        () => h.worker.fetch(h.request(), h.env, ctx), (record) => { failures.push(record); })));
      errors.mockRestore();
      expect(failed.map((response) => response.status)).toEqual([500, 500]);
      expect(failures.every((record) => record.catalog.source === "d1-miss")).toBe(true);
      expect(failures.reduce((sum, record) => sum + record.d1!.failures, 0)).toBe(1);
      expect(failures.reduce((sum, record) => sum + record.kv!.get.calls, 0)).toBe(1);
      for (const [key, value] of saved) h.values.set(key, value);
      expect((await h.worker.fetch(h.request(), h.env, ctx)).status).toBe(200);

    } finally { h.sqlite.close(); }
  });

  it("records denied/error/unreached phases and all snapshot fallback sources without changing responses", async () => {
    const h = fixture();
    try {
      await h.worker.getRuntime(h.env);
      const records: RequestDiagnosticRecord[] = [];
      const run = (authorized = true) => runWithRequestDiagnostics(options, () => h.worker.fetch(h.request(authorized), h.env, ctx), (record) => records.push(record));
      expect((await run(false)).status).toBe(401);
      expect(records.at(-1)).toMatchObject({ outcome: "denied", catalog: { source: "not-reached" }, phases: { role: null, catalog: null, dispatch: null }, d1: { statements: 1 } });
      h.role("user");
      expect((await run()).status).toBe(403);
      expect(records.at(-1)).toMatchObject({ phases: { catalog: null, dispatcherBuild: null, dispatch: null }, d1: { statements: 2 } });
      h.role("owner");
      h.values.clear();
      expect((await run()).status).toBe(200);
      expect(records.at(-1)).toMatchObject({ catalog: { source: "d1-miss" }, kv: { get: { calls: 1 }, put: { calls: 1 } }, d1: { statements: 3 } });
      h.values.set([...h.values.keys()][0]!, "invalid");
      expect((await run()).status).toBe(200);
      expect(records.at(-1)?.catalog.source).toBe("d1-repair");
      h.fail(true);
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      expect((await run()).status).toBe(200);
      warn.mockRestore();
      expect(records.at(-1)).toMatchObject({ catalog: { source: "d1-kv-error" }, kv: { get: { failures: 1 } } });
      expect(JSON.stringify(records)).not.toContain("PRIVATE_");
      let failed: RequestDiagnosticRecord | undefined;
      const failure = new Error("PRIVATE_FAILURE");
      await expect(runWithRequestDiagnostics(options, async () => { throw failure; }, (record) => { failed = record; throw new Error("observer failed"); }))
        .rejects.toBe(failure);
      expect(failed).toMatchObject({ status: null, outcome: "error", phases: { dispatch: null } });
      const response = new Response("kept", { status: 201 });
      expect(await runWithRequestDiagnostics(options, async () => response, () => { throw new Error("observer failed"); })).toBe(response);
      expect(await runWithRequestDiagnostics(options, async () => new Response("kept"), async () => { throw new Error("async observer failed"); }))
        .toBeInstanceOf(Response);
    } finally { h.sqlite.close(); }
  });

  it("preserves D1 receivers, bind chains, first columns and native batch objects; counts failures once", async () => {
    class Statement {
      #values: unknown[] = [];
      bind(...values: unknown[]) { const stmt = new Statement(); stmt.#values = values; return stmt; }
      async all() { return { success: true, results: [{ value: this.#values[0] }], meta: { rows_read: 1, rows_written: 0, duration: 0.5 } }; }
      async first(column?: string) { if (column === "missing") throw new Error("D1_COLUMN_NOTFOUND"); return column ? this.#values[0] : { value: this.#values[0] }; }
      async raw() { return [this.#values]; }
      async run() { return this.all(); }
      static nativeValue(stmt: Statement) { return stmt.#values[0]; }
    }
    const native = {
      prepare() { expect(this).toBe(native); return new Statement(); },
      async batch(statements: Statement[]) { statements.forEach((stmt) => Statement.nativeValue(stmt)); return Promise.all(statements.map((stmt) => stmt.all())); },
      withSession() { expect(this).toBe(native); return this; },
      async exec() { return { count: 2, duration: 1 }; },
    } as unknown as D1Database;
    const db = instrumentD1(native);
    expect(instrumentD1(db)).toBe(db);
    let record: RequestDiagnosticRecord | undefined;
    await runWithRequestDiagnostics(options, async () => {
      const stmt = db.prepare("not retained").bind("PRIVATE_DATA").bind(7);
      expect(await stmt.first()).toEqual({ value: 7 });
      expect(await stmt.first("value")).toBe(7);
      await expect(stmt.first("missing")).rejects.toThrow("D1_COLUMN_NOTFOUND");
      expect(await stmt.raw()).toEqual([[7]]);
      const driver = new D1DatabaseDriver(db);
      expect(await driver.batch([driver.prepare("one").bind(1), driver.prepare("two").bind(2)])).toHaveLength(2);
      expect(await db.withSession().prepare("three").bind(3).all()).toMatchObject({ results: [{ value: 3 }] });
      await db.exec("two statements");
      return new Response("ok");
    }, (value) => { record = value; });
    expect(record?.d1).toMatchObject({ bindingCalls: 7, statements: 9, failures: 1, unknownStatementCalls: 0, metadataStatements: 3, rowsRead: 3, rowsWritten: 0, durationMs: 2.5 });
    expect(JSON.stringify(record)).not.toContain("PRIVATE_DATA");
  });

  it("freezes the response-time observation before deferred I/O completes", async () => {
    const gate = deferred();
    const db = instrumentD1({ prepare: () => ({ all: async () => { await gate.promise; return { results: [], meta: { rows_read: 7 } }; } }) } as unknown as D1Database);
    let pending!: Promise<unknown>;
    let record: RequestDiagnosticRecord | undefined;
    await runWithRequestDiagnostics({ ...options, surface: "health" }, async () => {
      pending = db.prepare("PRIVATE_SQL").all();
      return new Response("done");
    }, (value) => { record = value; });
    expect(record?.d1).toMatchObject({ statements: 1, inFlight: 1, maxInFlight: 1, rowsRead: null });
    gate.resolve();
    await pending;
    expect(record?.d1).toMatchObject({ inFlight: 1, rowsRead: null });
  });

  it("keeps R2 streams native and counts payload bytes only after successful transfer", async () => {
    const body = new Blob(["hello"]).stream();
    const bucket = instrumentR2({
      async get() { return { body, size: 5 }; },
      async put(_key: string, input: ReadableStream) { expect(input).toBe(body); await new Response(input).arrayBuffer(); return { size: 5 }; },
    } as unknown as R2Bucket);
    let record: RequestDiagnosticRecord | undefined;
    await runWithRequestDiagnostics(options, async () => {
      const object = await bucket.get("PRIVATE_KEY");
      expect(object!.body).toBe(body);
      await bucket.put("PRIVATE_KEY", object!.body);
      return new Response("ok");
    }, (value) => { record = value; });
    expect(record?.r2).toMatchObject({ get: { calls: 1, bytes: 5, byteSamples: 1, bytesSource: "object-result" }, put: { calls: 1, bytes: 5, byteSamples: 1 } });
    expect(JSON.stringify(record)).not.toContain("PRIVATE_KEY");
    const rejected = instrumentR2({
      async get() { return { body: new Blob(["unknown partial payload"]).stream(), size: 23 }; },
      async put() { throw new Error("failed transfer"); },
    } as unknown as R2Bucket);
    await runWithRequestDiagnostics(options, async () => {
      const object = await rejected.get("PRIVATE_KEY");
      await expect(rejected.put("PRIVATE_KEY", object!.body)).rejects.toThrow("failed transfer");
      await object!.body.cancel();
      return new Response("handled");
    }, (value) => { record = value; });
    expect(record?.r2).toMatchObject({ get: { bytes: null, byteSamples: 0 }, put: { calls: 1, failures: 1, bytes: null } });

  });
});
