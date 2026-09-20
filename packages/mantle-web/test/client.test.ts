import { describe, expect, it, vi } from "vitest";
import { linkManifestSet, parseManifestSources } from "@aotter/mantle-spec";
import { compileRuntimePlan, createMantleRequestHandler, createMantleRuntime, prepareDeployment } from "@aotter/mantle-runtime";
import { InMemoryEntryRepository } from "../../mantle-runtime/test/fakes/in-memory-store.js";
import { createMantleClient } from "../src/client.js";
import { createRuntimeClient, projectFrontendContract } from "../src/client-runtime.js";

async function fixture() {
  const apiVersion = "cms.mantle.aotter.net/v1";
  const docs = [
    { apiVersion, kind: "Procedure", metadata: { name: "echo" }, spec: { requires: { auth: { all: ["ctx.user"] } }, input: { type: "object", properties: { text: { type: "string" } }, required: ["text"] }, output: { type: "object" }, handler: { kind: "ref", ref: "echo" } } },
    { apiVersion, kind: "Trigger", metadata: { name: "echo-http" }, spec: { source: { kind: "http", method: "POST", path: "/api/echo" }, target: { procedure: "echo" } } },
  ];
  const parsed = parseManifestSources({ sources: docs.map((doc, index) => ({ sourceId: String(index), text: JSON.stringify(doc) })) });
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.diagnostics));
  const linked = linkManifestSet(parsed.value);
  if (!linked.ok) throw new Error(JSON.stringify(linked.diagnostics));
  const compiled = compileRuntimePlan(linked.value);
  if (!compiled.ok) throw new Error(JSON.stringify(compiled.diagnostics));
  const handlers = { echo: async (input: unknown, ctx: { user?: { id: string } | null }) => ({ input, user: ctx.user?.id }) };
  const prepared = await prepareDeployment(compiled.value, { async prepare() { return { entries: new InMemoryEntryRepository(new Map()) }; } }, { handlers });
  const runtime = createMantleRuntime({ prepared, handlers, ports: { clock: { now: () => 1 }, idgen: { next: () => "one" } } });
  return { plan: compiled.value, getRuntime: async () => runtime };
}

describe("frontend client", () => {
  it("uses the same authorized Trigger and business errors locally and over HTTP", async () => {
    const options = await fixture();
    const context = { user: { id: "alice" }, staff: null, env: {} };
    const local = createRuntimeClient({ ...options, origin: "https://tenant.test", context });
    const handle = createMantleRequestHandler(options);
    const fetcher = vi.fn(async (input: RequestInfo | URL) => (await handle(input as Request, context))!);
    const remote = createMantleClient({ origin: "https://tenant.test", contract: projectFrontendContract(options.plan), fetch: fetcher });
    expect(await local.call("echo-http", { text: "hello" })).toEqual(await remote.call("echo-http", { text: "hello" }));
    for (const client of [local, remote]) await expect(client.call("echo-http", {})).rejects.toMatchObject({ status: 400, diagnostic: { code: "INPUT_VALIDATION_FAILED" } });
    const anonymous = createRuntimeClient({ ...options, origin: "https://tenant.test", context: { user: null, staff: null, env: {} } });
    await expect(anonymous.call("echo-http", { text: "no" })).rejects.toMatchObject({ status: 401 });
    const bob = createRuntimeClient({ ...options, origin: "https://tenant.test", context: { ...context, user: { id: "bob" } } });
    expect(await Promise.all([local.call("echo-http", { text: "a" }), bob.call("echo-http", { text: "b" })])).toMatchObject([{ user: "alice" }, { user: "bob" }]);
  });
  it("does not retry mutations, preserves OAuth challenge and abort, and rejects foreign routes", async () => {
    const { plan } = await fixture();
    const contract = projectFrontendContract(plan);
    const fetcher = vi.fn(async () => Response.json({ ok: false, diagnostic: { code: "UNAUTHENTICATED" } }, { status: 401, headers: { "www-authenticate": "Bearer" } }));
    const client = createMantleClient({ origin: "https://tenant.test", contract, fetch: fetcher });
    await expect(client.call("echo-http", { text: "x" })).rejects.toMatchObject({ status: 401, challenge: "Bearer" });
    expect(fetcher).toHaveBeenCalledTimes(1);
    await expect(client.call("echo-http", {}, { signal: AbortSignal.abort() })).rejects.toMatchObject({ name: "AbortError" });
    expect(fetcher).toHaveBeenCalledTimes(1);
    for (const path of ["https://other.test/api/leak", "/api/../admin", "/api/x?secret", "//other.test/api/x"]) expect(() => createMantleClient({ origin: "https://tenant.test", contract: { ...contract, calls: [{ ...contract.calls[0]!, path }] } })).toThrow();
  });
});
