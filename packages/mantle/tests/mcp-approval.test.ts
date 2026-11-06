import { expect, test } from "bun:test";
import { mcp } from "../src/kernel/mcp.js";
import { ApprovalRequired, isApprovalRequired } from "../src/kernel/approval.js";
import { hostCaller, hostFailure } from "../src/kernel/host-caller.js";
import { surfaceFailure } from "../src/kernel/surface-failure.js";
import { mantleProps } from "./gateway-fixture.js";
import { ContractError, wire } from "../src/kernel/contracts.js";

const url = "https://app.test/approve/a1";
const tool = (name: string, extra: Record<string, unknown> = {}) => ({ name, surface: "public" as const, description: name, inputSchema: { type: "object" }, validate: (raw: unknown) => raw as Record<string, unknown>, run: async () => { throw new ApprovalRequired({ url, message: "Approve the billing run." }); }, ...extra });
const handle = mcp([tool("sign"), tool("typed", { outputSchema: { type: "object" } }), tool("custom", { run: async () => { throw new ApprovalRequired({ url, message: "Approve.", fallback: "Ask the user to open the link." }); } })], { db: () => ({}), caller: () => ({ kind: "anonymous" }) });
const modern = (capabilities: Record<string, unknown>) => ({ "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientCapabilities": capabilities, "io.modelcontextprotocol/clientInfo": { name: "test", version: "1" } });
const call = async (name: string, params: Record<string, unknown> = {}, era?: string) => {
  const response = await handle(new Request("https://app.test/mcp", { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(era ? { "mcp-protocol-version": era, "mcp-method": "tools/call", "mcp-name": name } : {}) }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: {}, ...params } }) }), {});
  const body = await response!.text();
  return JSON.parse(body.startsWith("event:") ? body.split("data: ")[1]!.split("\n")[0]! : body);
};

test("ApprovalRequired asks for URL elicitation only on a 2026-07-28 request that declares it", async () => {
  const asked = (await call("sign", { _meta: modern({ elicitation: { url: {} } }) }, "2026-07-28")).result;
  expect(asked.resultType).toBe("input_required");
  expect(asked.inputRequests).toEqual({ "net.aotter.mantle/approval": { method: "elicitation/create", params: { mode: "url", url, message: "Approve the billing run." } } });
  // A retry that still needs approval does not ask again: the host gets the fallback instead of a loop.
  const retried = (await call("sign", { _meta: modern({ elicitation: { url: {} } }), inputResponses: { "net.aotter.mantle/approval": { action: "decline" } } }, "2026-07-28")).result;
  expect(retried.isError).toBe(true);
  expect(retried.content[0]).toEqual({ type: "text", text: `Approve the billing run. Open ${url}, then call this tool again.` });
  // So does a response the SDK dropped as malformed: it was answered, only in the wrong shape.
  const wrapped = (await call("sign", { _meta: modern({ elicitation: { url: {} } }), inputResponses: { "net.aotter.mantle/approval": { method: "elicitation/create", result: { action: "accept" } } } }, "2026-07-28")).result;
  expect(wrapped.resultType).not.toBe("input_required"); expect(wrapped.isError).toBe(true);
  for (const [params, era] of [[{ _meta: modern({ elicitation: { form: {} } }) }, "2026-07-28"], [{ _meta: modern({}) }, "2026-07-28"], [{}, undefined]] as const) {
    const result = (await call("sign", params, era)).result;
    expect(result.resultType).not.toBe("input_required");
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe(`Approve the billing run. Open ${url}, then call this tool again.`);
    expect(result.structuredContent.diagnostics[0]).toMatchObject({ code: "APPROVAL_REQUIRED", url });
    // The fallback is not an input mistake, so the input schema is not repeated.
    expect(JSON.stringify(result.content)).not.toContain("input schema");
  }
  // A tool with an output schema still answers a valid error result.
  const typed = (await call("typed")).result;
  expect(typed.isError).toBe(true);
  expect(typed.content[0].text).toContain(url);
  expect((await call("custom")).result.content[0].text).toBe("Ask the user to open the link.");
});

test("ApprovalRequired is a 428 ContractError with a credential-free absolute URL", () => {
  const error = new ApprovalRequired({ url, message: "Approve." }, "procedure:sign");
  expect(error).toBeInstanceOf(ContractError);
  expect(wire(error)).toEqual({ status: 428, error: { code: "APPROVAL_REQUIRED", message: "Approve.", path: "procedure:sign", url } });
  expect(isApprovalRequired(error)).toBe(true); expect(isApprovalRequired(new ContractError("APPROVAL_REQUIRED", "x"))).toBe(false); expect(isApprovalRequired(null)).toBe(false);
  for (const local of ["http://localhost:8787/approve/a1", "http://127.0.0.1/approve/a1", "http://[::1]/approve/a1"]) expect(new ApprovalRequired({ url: local, message: "x" }).url).toBe(local);
  for (const bad of ["/approve/a1", "javascript:alert(1)", "http://app.test/approve/a1", "https://user:pass@app.test/approve", "not a url"])
    expect(() => new ApprovalRequired({ url: bad, message: "x" })).toThrow(TypeError);
});

test("REST and host failures carry the approval URL; observations do not carry the step-up", async () => {
  const error = new ApprovalRequired({ url, message: "Approve." }, "procedure:sign");
  const local = surfaceFailure(error);
  expect(local.status).toBe(428); expect(((await local.json()) as { error: unknown }).error).toMatchObject({ code: "APPROVAL_REQUIRED", url });
  const caller = hostCaller(mantleProps({ stepUp: { acr: "x", auth_time: 1, nonce: "live" } }), { tenant: "example" });
  const host = hostFailure(error, caller);
  expect(host.status).toBe(428); expect(await host.json()).toEqual({ error: { code: "APPROVAL_REQUIRED", target: "procedure:sign", url } });
  const events: any[] = [];
  const observed = mcp([tool("sign")], { db: () => ({}), caller: () => caller, onObservation: (event: unknown) => { events.push(event); } });
  await observed(new Request("https://app.test/mcp", { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "sign", arguments: {} } }) }), {});
  const invocations = events.filter(event => event.kind === "invocation");
  expect(invocations.length).toBe(2);
  for (const event of invocations) { expect(event.caller.subject).toBe(caller.subject); expect("stepUp" in event.caller).toBe(false); }
  expect(invocations[1]).toMatchObject({ phase: "completion", outcome: "failed", code: "APPROVAL_REQUIRED" });
});
