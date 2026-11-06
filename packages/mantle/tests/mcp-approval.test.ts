import { expect, test } from "bun:test";
import { mcp } from "../src/kernel/mcp.js";
import { ApprovalRequired } from "../src/kernel/approval.js";
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
  for (const bad of ["/approve/a1", "javascript:alert(1)", "https://user:pass@app.test/approve", "not a url"])
    expect(() => new ApprovalRequired({ url: bad, message: "x" })).toThrow(TypeError);
});
