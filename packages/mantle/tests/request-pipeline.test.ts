/** The request pipeline's decision functions, and the order in which each surface runs its steps. */
import { expect, test } from "bun:test";
import { ContractError, deny, isAdmin, type Caller } from "../src/kernel/contracts.js";
import { mcp, type Tool } from "../src/kernel/mcp.js";
import { isRead, isView, originChecked } from "../src/kernel/request-pipeline.js";
import { nativeRest, rest, type Route } from "../src/kernel/rest.js";
import { web, type View } from "../src/kernel/web.js";
import { fixtureCaller } from "./apps/fixtures.js";

const member: Caller = fixtureCaller({
  kind: "user", subject: "member", role: null, scopes: ["mcp"], credential: "oauth", credentialId: null, clientId: null,
});
const adminOnly = (path: string) => (caller: Caller) => deny(caller, isAdmin(caller), path);

test("one function says what a read is, and one decides the Origin rule", () => {
  expect(isView({ page: () => {} })).toBe(true);
  const page = () => {}, run = () => {}, handle = () => {};
  for (const target of [{}, { run }, { handle }, { page, run }, { page, handle }]) expect(isView(target)).toBe(false);

  expect(isRead({ view: true })).toBe(true);
  expect(isRead({ view: false, readOnly: true })).toBe(true);
  expect(isRead({ view: false })).toBe(false);
  expect(isRead({ view: false, readOnly: false })).toBe(false);

  // [view, readOnly, forwarded host caller] -> must the call pass checkOrigin?
  const rule: readonly [boolean, boolean, boolean, boolean][] = [
    [true, false, false, false], [true, false, true, false],   // a View read never
    [false, false, false, true], [false, false, true, true],   // a write always
    [false, true, false, true],                                // a read-only Procedure under ambient (cookie) authority
    [false, true, true, false],                                // a read-only Procedure a gateway forwarded
  ];
  for (const [view, readOnly, host, checked] of rule) expect(originChecked({ view, readOnly }, host)).toBe(checked);
});

/** Records the order of the side effects a request causes. */
function recorder() {
  const steps: string[] = [];
  return {
    steps,
    note: <T>(step: string, value: T): T => { steps.push(step); return value; },
    caller: (caller: Caller) => () => { steps.push("caller"); return caller; },
  };
}
const rpc = (name: string, args: object = {}) => new Request("https://app.test/mcp", {
  method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
});
const rpcResult = async (response: Response) => {
  const text = await response.text();
  return JSON.parse(text.startsWith("event:") ? text.split("data: ")[1]!.split("\n")[0]! : text).result;
};

test("REST, MCP and web run the generated guard, then authorize, before any database handle", async () => {
  const target = { kind: "procedure" as const, name: "work" };

  const viaRest = recorder();
  const route: Route<null> = {
    method: "POST", pattern: /^\/api\/work$/, target, check: () => { viaRest.note("check", undefined); },
    validate: raw => viaRest.note("validate", raw as Record<string, unknown>), run: async () => viaRest.note("run", {}),
  };
  const api = rest([route], {
    db: () => viaRest.note("db", null), caller: viaRest.caller(member), authorize: () => viaRest.note("authorize", true),
  });
  expect((await api(new Request("https://app.test/api/work", { method: "POST", body: "{}" }), {}))!.status).toBe(200);
  expect(viaRest.steps).toEqual(["caller", "check", "authorize", "validate", "db", "run"]);

  // MCP authorizes every call of a batch before any call runs, then guards each call again where it executes.
  for (const authorize of [false, true]) {
    const viaMcp = recorder();
    const tool: Tool<null> = {
      name: "work", surface: "public", description: "Work", inputSchema: { type: "object" }, target,
      check: () => { viaMcp.note("check", undefined); }, validate: raw => viaMcp.note("validate", raw as Record<string, unknown>),
      run: async () => viaMcp.note("run", {}),
    };
    const tools = mcp([tool], {
      db: () => viaMcp.note("db", null), caller: viaMcp.caller(member),
      ...(authorize ? { authorize: () => viaMcp.note("authorize", true) } : {}),
    });
    expect((await rpcResult((await tools(rpc("work"), {}))!)).isError).toBeUndefined();
    expect(viaMcp.steps).toEqual(["caller", ...(authorize ? ["check", "authorize"] : []), "check", "validate", "db", "run"]);
  }

  // Web decodes a page's path fields first: that order predates the pipeline and is kept.
  const viaWeb = recorder();
  const view: View<null> = {
    check: () => { viaWeb.note("check", undefined); }, query: () => viaWeb.note("query", { input: {} }),
    page: async () => viaWeb.note("page", { rows: [{ title: "Text" }] }),
  };
  const site = web({
    db: null, caller: viaWeb.caller(member), authorize: () => viaWeb.note("authorize", true), origin: "https://app.test",
    title: "Site", description: "Site", pages: { "/work": { view: "work", markdown: "title" } },
  }, [["work", view]]);
  expect(await site.head(new Request("https://app.test/work"), {})).toContain("canonical");
  expect(viaWeb.steps).toEqual(["caller", "query", "check", "authorize", "page"]);
});

test("an MCP call refused by its guard never validates input or acquires a database, with or without authorize", async () => {
  for (const authorize of [false, true]) {
    let touched = 0;
    const tool: Tool<null> = {
      name: "manage", surface: "public", description: "Manage", inputSchema: { type: "object" },
      check: adminOnly("procedures/manage/requires/auth/all/0"),
      validate: () => { touched++; throw new ContractError("INPUT_VALIDATION_FAILED", "Bad input.", "procedures/manage"); },
      run: async () => { touched++; return {}; },
    };
    const db = () => { touched++; return null; };
    const tools = mcp([tool], { db, caller: () => member, ...(authorize ? { authorize: () => true } : {}) });
    const response = (await tools(rpc("manage", { bad: true }), {}))!;
    if (authorize) {
      // Application authorize answers before the SDK runs, as an HTTP refusal.
      expect(response.status).toBe(403);
      const refusal = await response.json() as { error: unknown };
      expect(refusal.error).toMatchObject({ code: "AUTH_DENIED", path: "procedures/manage/requires/auth/all/0" });
    } else {
      const result = await rpcResult(response);
      expect(result.isError).toBe(true);
      expect(result.structuredContent.diagnostics[0]).toMatchObject({ code: "AUTH_DENIED", path: "procedures/manage/requires/auth/all/0" });
    }
    expect(touched).toBe(0);
  }
});

test("nativeRest guards a route that declares check or target, before its handler", async () => {
  let handled = 0, authorized = 0;
  const handle = async () => { handled++; return {}; };
  const routes: Route<null>[] = [
    { method: "POST", pattern: /^\/guarded$/, check: adminOnly("native/guarded"), handle },
    { method: "POST", pattern: /^\/targeted$/, target: { kind: "procedure", name: "targeted" }, handle },
    { method: "POST", pattern: /^\/plain$/, handle },
  ];
  const api = nativeRest(routes, { db: () => null, caller: () => member, authorize: () => { authorized++; return false; } });
  const post = (path: string) => api(new Request("https://app.test" + path, { method: "POST", body: "{}" }), {});
  expect((await post("/guarded"))!.status).toBe(403);
  expect((await post("/targeted"))!.status).toBe(403);
  expect([handled, authorized]).toEqual([0, 1]);
  // A route that declares neither is the handler's own to authorize, as Admin's table is.
  expect((await post("/plain"))!.status).toBe(200);
  expect([handled, authorized]).toEqual([1, 1]);
});
