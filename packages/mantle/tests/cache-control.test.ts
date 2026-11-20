/**
 * Every response a surface builds states its Cache-Control, so a shared cache in front of the Worker (Workers Cache)
 * stores only what a surface marked public. Gateway answers and dry runs are pinned by `host-contract.golden.json`,
 * every Admin API cell by Admin's request matrix.
 */
import { expect, spyOn, test } from "bun:test";
import { authRoutes } from "../src/auth/routes.js";
import { authSetupIncomplete } from "../src/auth/hardening.js";
import type { Caller } from "../src/kernel/contracts.js";
import { mcp, type Tool, type ToolCall } from "../src/kernel/mcp.js";
import { nativeRest, rest, type Route } from "../src/kernel/rest.js";
import { web, type View } from "../src/kernel/web.js";
import { fixtureCaller } from "./apps/fixtures.js";
import { mcpInit } from "./mcp-wire.js";

const user: Caller = fixtureCaller({
  kind: "user",
  subject: "u",
  role: null,
  scopes: ["mcp"],
  credential: "session",
  credentialId: null,
  clientId: null,
});
const anonymous: Caller = { kind: "anonymous" };
const PRIVATE = "private, no-store";
const at = (path: string, init?: RequestInit) => new Request("https://app.test" + path, init);
const rpc = (body: unknown, headers: Record<string, string> = {}) => at("/mcp", mcpInit(body, { headers }));
const call = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "work", arguments: {} } };

test("REST, MCP, web and auth state Cache-Control on success and error paths", async () => {
  const log = spyOn(console, "error").mockImplementation(() => {});
  const view: Route<null> = {
    method: "GET",
    pattern: /^\/api\/views\/x$/,
    query: () => ({ input: {} }),
    page: async () => ({ rows: [] }),
  };
  const api = rest([view], { db: () => null, caller: () => user });
  const native = nativeRest(
    [
      { method: "GET", pattern: /^\/api\/raw$/, readOnly: true, handle: async () => ({}) },
      { method: "GET", pattern: /^\/api\/throws$/, readOnly: true, handle: async () => Promise.reject(new Error("x")) },
    ],
    { db: () => null, caller: () => user },
  );
  const tool: Tool<null> = {
    name: "work",
    surface: "public",
    description: "Work",
    inputSchema: { type: "object" },
    validate: raw => raw as Record<string, unknown>,
    // A call that reports progress is answered as an SSE stream.
    run: async (_db: unknown, _caller: unknown, _input: unknown, _handlers: unknown, call: ToolCall) => {
      await call.progress?.(1, 1);
      return {};
    },
  };
  const tools = mcp([tool], { db: () => null, caller: () => user });
  const closed = mcp([{ ...tool, closed: true }], { db: () => null, caller: () => anonymous });
  const bearer = mcp([tool], { db: () => null, caller: () => fixtureCaller({ ...user, credential: "oauth" }) });
  const site = (caller: Caller, cacheControl?: string) =>
    web(
      {
        db: null,
        caller: () => caller,
        cacheControl,
        origin: "https://app.test",
        title: "Site",
        description: "Site",
        pages: { "/work": { view: "work", markdown: "title", list: "work" } },
      },
      [
        [
          "work",
          {
            query: () => ({ input: {} }),
            page: async () => ({ rows: [{ title: "Text" }] }),
          } satisfies View<null>,
        ],
      ],
    );
  const failing = web(
    {
      db: null,
      caller: () => Promise.reject(new Error("resolver failed")),
      origin: "https://app.test",
      title: "Site",
      description: "Site",
      pages: { "/work": { view: "work", markdown: "title" } },
    },
    [["work", { query: () => ({ input: {} }), page: async () => ({ rows: [] }) }]],
  );
  // A Better Auth instance answering the way 1.7 does: most answers without Cache-Control, discovery metadata public.
  const auth = {
    options: { basePath: "/api/auth" },
    handler: async (request: Request) =>
      new URL(request.url).pathname.startsWith("/.well-known/")
        ? Response.json({}, { headers: { "cache-control": "public, max-age=15" } })
        : new URL(request.url).pathname.endsWith("/redirect")
          ? Response.redirect("https://provider.test/authorize", 302)
          : Response.json({ sessions: [] }),
  };
  const routes = authRoutes({ cookiePrefix: "better-auth", get: async () => auth } as never, {
    methods: [],
    resolver: () => user,
  });

  const cases: [string, Promise<Response | null | undefined> | Response, string][] = [
    ["rest GET", api(at("/api/views/x"), {}), PRIVATE],
    ["rest HEAD", api(at("/api/views/x", { method: "HEAD" }), {}), PRIVATE],
    ["rest OPTIONS (405)", api(at("/api/views/x", { method: "OPTIONS" }), {}), PRIVATE],
    ["rest unknown path (404)", api(at("/api/nope"), {}), PRIVATE],
    ["native route JSON", native(at("/api/raw"), {}), PRIVATE],
    ["native route throws (500)", native(at("/api/throws"), {}), PRIVATE],
    // 2026-07-28 answers a call as JSON, and streams it (SSE) once the call sends a progress notification.
    ["mcp tools/call (JSON)", tools(rpc(call), {}), PRIVATE],
    [
      "mcp tools/call (SSE)",
      // A bearer caller, whose call runs (a session's write needs its own Origin), and reports its progress.
      bearer(rpc({ ...call, params: { ...call.params, _meta: { progressToken: 1 } } }), {}),
      "no-cache, no-transform",
    ],
    ["mcp malformed JSON (400)", tools(rpc("{"), {}), PRIVATE],
    ["mcp JSON-only Accept", tools(rpc(call, { accept: "application/json" }), {}), PRIVATE],
    ["mcp GET (405)", tools(at("/mcp"), {}), PRIVATE],
    ["mcp OPTIONS (405)", tools(at("/mcp", { method: "OPTIONS" }), {}), PRIVATE],
    ["mcp foreign Origin (403)", tools(rpc(call, { origin: "https://other.test" }), {}), PRIVATE],
    ["mcp body too large (413)", tools(rpc("x".repeat(1024 * 1024 + 1)), {}), PRIVATE],
    ["mcp OAuth challenge (401)", closed(rpc(call), {}), PRIVATE],
    ["web .md anonymous", site(anonymous).fetch(at("/work.md"), {}), "public, max-age=60"],
    [
      "web .md anonymous, cacheControl",
      site(anonymous, "public, max-age=5").fetch(at("/work.md"), {}),
      "public, max-age=5",
    ],
    ["web llms.txt signed in", site(user).fetch(at("/llms.txt"), {}), PRIVATE],
    ["web sitemap.xml signed in", site(user).fetch(at("/sitemap.xml"), {}), PRIVATE],
    ["web resolver failure (500)", failing.fetch(at("/work.md"), {}), PRIVATE],
    ["auth /methods", routes(at("/api/auth/methods")), PRIVATE],
    ["auth pass-through without a header", routes(at("/api/auth/list-sessions")), PRIVATE],
    ["auth pass-through redirect (immutable headers)", routes(at("/api/auth/redirect")), PRIVATE],
    [
      "auth discovery keeps its own header",
      routes(at("/.well-known/oauth-authorization-server")),
      "public, max-age=15",
    ],
    ["auth malformed path (400)", routes(at("/api/auth/admin/%2e%2e/x")), PRIVATE],
    ["auth setup incomplete (503)", authSetupIncomplete(), "no-store"],
  ];
  const seen = [];
  for (const [name, response, expected] of cases) {
    const answer = await response;
    seen.push([name, answer?.headers.get("cache-control") ?? null]);
    // SDK 2.4.0 states the one method an MCP endpoint takes on each of its 405s.
    if (name.startsWith("mcp") && name.endsWith("(405)")) expect(answer?.headers.get("allow")).toBe("POST");
    void answer?.body?.cancel();
  }
  expect(seen).toEqual(cases.map(([name, , expected]) => [name, expected]));
  log.mockRestore();
});

test("a 304 keeps the 200's Cache-Control", async () => {
  const site = web(
    {
      db: null,
      origin: "https://app.test",
      title: "Site",
      description: "Site",
      pages: { "/work": { view: "work", markdown: "title" } },
    },
    [["work", { query: () => ({ input: {} }), page: async () => ({ rows: [{ title: "Text" }] }) }]],
  );
  const first = (await site.fetch(at("/work.md"), {}))!;
  const again = (await site.fetch(at("/work.md", { headers: { "if-none-match": first.headers.get("etag")! } }), {}))!;
  expect([again.status, again.headers.get("cache-control")]).toEqual([304, "public, max-age=60"]);
});
