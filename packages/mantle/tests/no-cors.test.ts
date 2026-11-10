/**
 * No surface answers with CORS headers: a same-site page that can send a credentialed cross-origin read must not be
 * allowed to read the response. Admin's matrix pins the same for every Admin cell.
 */
import { expect, test } from "bun:test";
import type { Caller } from "../src/kernel/contracts.js";
import { mcp, type Tool } from "../src/kernel/mcp.js";
import { nativeRest, rest, type Route } from "../src/kernel/rest.js";
import { web, type View } from "../src/kernel/web.js";
import { fixtureCaller } from "./apps/fixtures.js";

const caller: Caller = fixtureCaller({
  kind: "user",
  subject: "u",
  role: null,
  scopes: ["mcp"],
  credential: "session",
  credentialId: null,
  clientId: null,
});
const cross = { origin: "https://other.test", "sec-fetch-site": "same-site" };
const preflight = { ...cross, "access-control-request-method": "POST" };
const cors = (response: Response | undefined) =>
  [...(response?.headers.keys() ?? [])].filter(name => name.startsWith("access-control-"));

test("rest, nativeRest, mcp and web send no access-control-* header", async () => {
  const route: Route<null> = {
    method: "GET",
    pattern: /^\/api\/views\/x$/,
    query: () => ({ input: {} }),
    page: async () => ({ rows: [] }),
  };
  const api = rest([route], { db: () => null, caller: () => caller });
  const native = nativeRest([{ method: "GET", pattern: /^\/api\/raw$/, readOnly: true, handle: async () => ({}) }], {
    db: () => null,
    caller: () => caller,
  });
  for (const fetch of [api, native])
    for (const [path, headers] of [
      ["/api/views/x", cross],
      ["/api/raw", cross],
      ["/api/nope", cross],
      ["/api/views/x", preflight],
    ] as const) {
      const method = headers === preflight ? "OPTIONS" : "GET";
      const response = await fetch(new Request("https://app.test" + path, { method, headers }), {});
      expect(cors(response)).toEqual([]);
    }

  const tool: Tool<null> = {
    name: "work",
    surface: "public",
    description: "Work",
    inputSchema: { type: "object" },
    validate: raw => raw as Record<string, unknown>,
    run: async () => ({}),
  };
  const tools = mcp([tool], { db: () => null, caller: () => caller });
  const call = new Request("https://app.test/mcp", {
    method: "POST",
    headers: { ...cross, "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "work", arguments: {} } }),
  });
  for (const request of [call, new Request("https://app.test/mcp", { method: "OPTIONS", headers: preflight })])
    expect(cors(await tools(request, {}))).toEqual([]);

  const view: View<null> = { query: () => ({ input: {} }), page: async () => ({ rows: [{ title: "Text" }] }) };
  const site = web(
    {
      db: null,
      caller: () => caller,
      origin: "https://app.test",
      title: "Site",
      description: "Site",
      pages: { "/work": { view: "work", markdown: "title" } },
    },
    [["work", view]],
  );
  for (const request of [
    new Request("https://app.test/work", { headers: cross }),
    new Request("https://app.test/work", { method: "OPTIONS", headers: preflight }),
  ])
    expect(cors(await site.fetch(request, {}))).toEqual([]);
});
