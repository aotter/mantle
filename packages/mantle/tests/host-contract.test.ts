/**
 * Host platform contract v1. This fixture changes only together with a `v` bump.
 *
 * Fixed `ctx.props.mantle` inputs and the exact outputs a host observes: the caller `hostCaller` builds, every refusal
 * it makes, and what REST, MCP and web answer and report to `onAccess` in gateway mode. The expectations live in
 * `host-contract.golden.json`; a generated target hash appears there as `<hash:target id>`.
 */
import { expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fieldsOf, hasRole, rolesOf } from "../src/kernel/caller-identity.js";
import { ContractError, isAdmin } from "../src/kernel/contracts.js";
import { hostCaller, type HostProps } from "../src/kernel/host-caller.js";
import { generateOrThrow, writeGenerated } from "./apps/link.js";
import { gatewaySource, mantleProps } from "./gateway-fixture.js";
import { describeOf, fill, prober, variants } from "./match-target-fixture.js";
import { matchTarget } from "../dist/domain/describe/index.js";
import { rest as kernelRest, type Route } from "../src/kernel/rest.js";
import { mcp as kernelMcp, type Tool } from "../src/kernel/mcp.js";

const GOLDEN = resolve(import.meta.dir, "host-contract.golden.json");
const ORIGIN = "https://app.test";
const fields = { region: { type: "string" as const, multiple: true, enum: ["TW", "JP"] }, stores: { type: "string" as const, multiple: true } };
const user = { id: "person", role: "editor,content-admin", region: ["TW"], stores: ["A"] };
/** The fixed contract every case starts from. */
const base = (overrides: Partial<HostProps> = {}): HostProps =>
  ({ ...mantleProps({ user, target: "view:public-records", targetHash: "hash-1" }), ...overrides });
const manifest = (kind: string, name: string, spec: object) =>
  JSON.stringify({ apiVersion: "cms.mantle.aotter.net/v2", kind, metadata: { name }, spec });
/** The gateway fixture app, plus a View restricted by a user field and a route with a path parameter. */
const source = [
  gatewaySource,
  manifest("View", "restricted-records", {
    surface: "public", restrict: { records: "region IN auth.user('region')" }, sql: "SELECT id,title FROM records ORDER BY region,store,id",
  }),
  manifest("Procedure", "rename", {
    requires: { auth: { all: ["ctx.user"] } },
    input: { type: "object", required: ["id", "title"], properties: { id: { type: "string" }, title: { type: "string" } }, additionalProperties: false },
    output: { type: "object" }, handler: { sql: "UPDATE records SET title=input.title WHERE id=input.id RETURNING id,title" },
  }),
  manifest("Trigger", "rename-http", { source: { kind: "http", method: "POST", path: "/api/records/{id}/rename" }, target: { procedure: "rename" } }),
].join("\n---\n");
const without = (props: object, ...keys: string[]) => Object.fromEntries(Object.entries(props).filter(([key]) => !keys.includes(key)));

test("host contract v1: callers, refusals, surface answers and access events", async () => {
  const recorded: Record<string, unknown> = {};

  // (a) Accepted props: every observable field of the caller, for both layers.
  for (const layer of ["member", "admin"] as const) {
    for (const [variant, overrides] of Object.entries({
      plain: {}, snapshot: { authenticatedAs: "snapshot" as const }, session: { credential: "session" as const }, "dry-run": { dryRun: true },
      "all-values": { user: { ...user, region: { all: true as const } } },
    })) {
      const props = layer === "member" && variant === "plain" ? without(base({ layer }), "target", "targetHash") : base({ layer, ...overrides });
      const caller = hostCaller(props, { tenant: "example", fields });
      recorded[`caller ${layer} ${variant}`] = {
        caller: { ...caller }, keys: Object.keys(caller).sort(), frozen: Object.isFrozen(caller),
        brand: { admin: isAdmin(caller), roles: rolesOf(caller), fields: fieldsOf(caller), hasContentAdmin: hasRole(caller, "content-admin") },
        // a copy carries no authority
        copy: { admin: isAdmin({ ...caller }), fields: fieldsOf({ ...caller }) },
      };
    }
  }

  // (b) Every refusal: 412 HOST_CONTRACT, and the field it names.
  const refusals: Record<string, unknown> = {
    "not an object": null, "an array": [base()], "a class instance": new (class Props {})(),
    "unknown key": { ...base(), extra: 1 }, "v 2": { ...base(), v: 2 }, "v missing": without(base(), "v"),
    "tenant mismatch": base({ tenant: "other" }), "tenant empty": base({ tenant: "" }),
    "layer owner": { ...base(), layer: "owner" }, "authenticatedAs stale": { ...base(), authenticatedAs: "stale" },
    "credential api-key": { ...base(), credential: "api-key" },
    "requestId missing": without(base(), "requestId"), "requestId empty": base({ requestId: "" }), "requestId NUL": base({ requestId: "a\0b" }),
    "user missing": without(base(), "user"), "user an array": { ...base(), user: [] },
    "target empty": base({ target: "" }), "target not text": { ...base(), target: 1 }, "targetHash not text": { ...base(), targetHash: true },
    "dryRun not boolean": { ...base(), dryRun: "true" },
    "admin without target": without(base(), "target"), "admin without targetHash": without(base(), "targetHash"),
    "user id empty": base({ user: { ...user, id: "" } }), "user id not text": { ...base(), user: { ...user, id: 7 } },
    "subject prefix host:": base({ user: { ...user, id: "host:x" } }), "subject prefix SYSTEM:": base({ user: { ...user, id: "SYSTEM:x" } }),
    "role invalid": base({ user: { ...user, role: "Bad-role" } }),
    "field outside enum": base({ user: { ...user, region: ["XX"] } }), "field wrong type": { ...base(), user: { ...user, stores: [1] } },
    "field all with extra key": { ...base(), user: { ...user, region: { all: true, extra: true } } },
  };
  for (const [name, props] of Object.entries(refusals)) {
    let refusal: unknown = "accepted";
    try { hostCaller(props, { tenant: "example", fields }); }
    catch (error) {
      const { code, status, message, path, fields: named } = error as ContractError;
      refusal = { instance: error instanceof ContractError, code, status, message, path, fields: named ?? null };
    }
    recorded[`refusal: ${name}`] = refusal;
  }

  // (c) Each surface in gateway mode: the answer, and the exact AccessEvent handed to onAccess.
  const files = await generateOrThrow("bun-sqlite", [{ sourceId: "gateway.yaml", text: source }]);
  const dir = await mkdtemp(resolve(import.meta.dir, ".host-contract-")), db = new Database(":memory:");
  const log = spyOn(console, "error").mockImplementation(() => {});
  try {
    await writeGenerated(dir, files);
    db.exec(files["schema.sql"]!);
    const app = await import(resolve(dir, "generated.ts"));
    const records = app.store(db, { kind: "system", reason: "fixture" }).collection("records");
    const row = await records.insert({ region: "TW", store: "A", title: "first" });
    const others = [await records.insert({ region: "JP", store: "A", title: "second" }), await records.insert({ region: "TW", store: "B", title: "third" })];
    /** Row ids are random per run. */
    const rowIds: string[] = [row.id, ...others.map(other => other.id)];
    let acquired = 0;
    const getDb = () => { acquired++; return db; };
    const titles = () => (db.query("SELECT title FROM records ORDER BY title").all() as { title: string }[]).map(record => record.title);
    const { targets } = await import(resolve(dir, "access-targets.ts")) as { targets: Record<string, { targetHash: string }> };
    const { rest } = await import(resolve(dir, "rest.ts")), { mcp } = await import(resolve(dir, "mcp.ts")), { web } = await import(resolve(dir, "web.ts"));
    const events: object[] = [];
    let touch: "ok" | "unauthenticated" = "ok";
    const shared = { gateway: { tenant: "example" }, onAccess: (event: object) => { events.push(event); } };
    const handlers = { touch: () => { if (touch === "unauthenticated") throw new ContractError("UNAUTHENTICATED", "Sign in again."); return { touched: true }; } };
    const api = rest({ ...shared, handlers, db: getDb }), tools = mcp({ ...shared, handlers, db: getDb });
    const pages = { "/records": { view: "public-records", list: "public-records", markdown: "title" } };
    const site = web({ ...shared, db, origin: ORIGIN, title: "Records", description: "Records", pages });

    /** Generated hashes differ between generator versions; the contract is that the event carries the target's own. */
    const stable = (value: unknown): unknown => JSON.parse(JSON.stringify(value ?? null), (_, item) => {
      const id = typeof item === "string" ? Object.keys(targets).find(key => targets[key]!.targetHash === item) : undefined;
      return id ? `<hash:${id}>` : rowIds.includes(item) ? `<row ${rowIds.indexOf(item) + 1}>` : item;
    });
    /** Props pinned to `id` with its generated hash, unless a case overrides either. */
    const pinnedTo = (id: string, overrides: Partial<HostProps> = {}) => base({ target: id, targetHash: targets[id]?.targetHash ?? "unknown", ...overrides });
    type Answer = { status: number; wwwAuthenticate: string | null; body: any };
    const answers: Record<string, Answer> = {}, acquisitions: Record<string, number> = {};
    const record = async (name: string, call: () => Promise<unknown>) => {
      events.length = 0; acquired = 0;
      const answer = await call();
      await new Promise(done => setTimeout(done, 0));
      const frozen = events.map(event => Object.isFrozen(event) && Object.isFrozen((event as { caller: object }).caller));
      recorded[name] = stable({ answer, events, frozen });
      answers[name] = answer as Answer; acquisitions[name] = acquired;
    };
    const http = async (response: Response | undefined) => {
      if (!response) return "unserved";
      const text = await response.text();
      let body: any = text;
      try { body = JSON.parse(text.startsWith("event:") ? text.split("data: ")[1]!.split("\n")[0]! : text); } catch {}
      // A tool result's text blocks repeat its structured content and name the tool version.
      if (body?.jsonrpc === "2.0" && body.result) {
        const { isError = false, structuredContent = null, content } = body.result;
        // A tool with an output schema reports its failure in the text block alone.
        const diagnostics = isError ? structuredContent?.diagnostics ?? JSON.parse(content[0].text).diagnostics : null;
        body = { result: { isError, structuredContent, diagnostics } };
      }
      return { status: response.status, wwwAuthenticate: response.headers.get("www-authenticate"), cacheControl: response.headers.get("cache-control"), body };
    };
    const input = { id: row.id, version: row.version, title: "changed" };

    const restCall = (props: unknown, path: string, body?: object | string) => async () => {
      const init = body === undefined ? {} : { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) };
      return http(await api(new Request(ORIGIN + path, init), {}, { props: { mantle: props } }));
    };
    const READ = "rest:GET /api/views/public-records", WRITE = "rest:POST /api/write", TOUCH = "rest:POST /api/touch";
    await record("rest allow admin read", restCall(pinnedTo(READ), "/api/views/public-records"));
    await record("rest allow member read",
      restCall(without(base({ layer: "member" }), "target", "targetHash"), "/api/views/public-records"));
    await record("rest TARGET_MISMATCH", restCall(pinnedTo(READ, { target: "procedure:write" }), "/api/views/public-records"));
    await record("rest TARGET_HASH_MISMATCH", restCall(pinnedTo(READ, { targetHash: "old" }), "/api/views/public-records"));
    await record("rest STALE_CALLER snapshot write", restCall(pinnedTo(WRITE, { authenticatedAs: "snapshot" }), "/api/write", input));
    await record("rest dry run write", restCall(pinnedTo(WRITE, { dryRun: true }), "/api/write", input));
    await record("rest DRY_RUN_UNSUPPORTED ref handler", restCall(pinnedTo(TOUCH, { dryRun: true }), "/api/touch", {}));
    await record("rest deny member write", restCall(without(base({ layer: "member" }), "target", "targetHash"), "/api/write", input));
    await record("rest error invalid input", restCall(pinnedTo(WRITE), "/api/write", "{"));
    await record("rest error invalid input dry run", restCall(pinnedTo(WRITE, { dryRun: true }), "/api/write", { ...input, title: 1 }));
    await record("rest HOST_CONTRACT unknown key", restCall({ ...pinnedTo(READ), extra: 1 }, "/api/views/public-records"));
    await record("rest HOST_CONTRACT admin without target", restCall(without(pinnedTo(READ), "target"), "/api/views/public-records"));
    await record("rest HOST_CONTRACT missing user field",
      restCall(pinnedTo(READ, { user: without(user, "region") as HostProps["user"] }), "/api/views/public-records"));
    await record("rest origin session write", restCall(pinnedTo(WRITE, { credential: "session" }), "/api/write", input));
    touch = "unauthenticated";
    await record("rest 401 answered as 403", restCall(pinnedTo(TOUCH), "/api/touch", {}));
    touch = "ok";
    await record("rest allow write", restCall(pinnedTo(WRITE), "/api/write", input));

    const mcpCall = (props: unknown, name: string, args: object = {}, path = "/mcp", method = "tools/call") => async () => {
      const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: method === "tools/call" ? { name, arguments: args } : {} });
      const headers = { "content-type": "application/json", accept: "application/json, text/event-stream" };
      return http(await tools(new Request(ORIGIN + path, { method: "POST", body, headers }), {}, { props: { mantle: props } }));
    };
    const VIEW = "view:public-records", PROCEDURE = "procedure:write", REF = "procedure:touch";
    const current = () => ({ ...input, version: (db.query("SELECT version FROM records WHERE id=?").get(row.id) as { version: number }).version });
    await record("mcp allow admin read", mcpCall(pinnedTo(VIEW), "public_records"));
    await record("mcp allow member read", mcpCall(without(base({ layer: "member" }), "target", "targetHash"), "public_records"));
    await record("mcp TARGET_MISMATCH", mcpCall(pinnedTo(VIEW, { target: PROCEDURE }), "public_records"));
    await record("mcp TARGET_HASH_MISMATCH", mcpCall(pinnedTo(VIEW, { targetHash: "old" }), "public_records"));
    await record("mcp STALE_CALLER snapshot write", mcpCall(pinnedTo(PROCEDURE, { authenticatedAs: "snapshot" }), "write", input));
    await record("mcp dry run write", mcpCall(pinnedTo(PROCEDURE, { dryRun: true }), "write", input));
    await record("mcp DRY_RUN_UNSUPPORTED ref handler", mcpCall(pinnedTo(REF, { dryRun: true }), "touch"));
    await record("mcp deny member write", mcpCall(without(base({ layer: "member" }), "target", "targetHash"), "write", input));
    await record("mcp deny member on admin endpoint",
      mcpCall(without(base({ layer: "member" }), "target", "targetHash"), "admin_records", {}, "/mcp/admin"));
    await record("mcp error invalid input", mcpCall(pinnedTo(PROCEDURE), "write", { ...input, title: 1 }));
    await record("mcp error unknown tool", mcpCall(pinnedTo(PROCEDURE), "missing"));
    await record("mcp deny tools/list", mcpCall(pinnedTo(VIEW), "", {}, "/mcp", "tools/list"));
    await record("mcp HOST_CONTRACT unknown key", mcpCall({ ...pinnedTo(VIEW), extra: 1 }, "public_records"));
    await record("mcp HOST_CONTRACT missing user field",
      mcpCall(pinnedTo(VIEW, { user: without(user, "region") as HostProps["user"] }), "public_records"));
    await record("mcp origin session write", mcpCall(pinnedTo(PROCEDURE, { credential: "session" }), "write", input));
    await record("mcp origin session write, member refused by requires",
      mcpCall(without(base({ layer: "member", credential: "session" }), "target", "targetHash"), "write", input));
    touch = "unauthenticated";
    await record("mcp 401 answered as AUTH_DENIED", mcpCall(pinnedTo(REF), "touch"));
    touch = "ok";
    await record("mcp allow write", mcpCall(pinnedTo(PROCEDURE), "write", current()));

    const page = (props: unknown, path = "/records.md") => async () => http(await site.fetch(new Request(ORIGIN + path), {}, { props: { mantle: props } }));
    const head = (props: unknown) => async () => {
      try { return { tags: await site.head(new Request(ORIGIN + "/records"), {}, { props: { mantle: props } }) }; }
      catch (error) { const { code, status, path } = error as ContractError; return { throws: { code, status, path } }; }
    };
    await record("web allow admin page", page(pinnedTo(VIEW)));
    await record("web allow member sitemap", page(without(base({ layer: "member" }), "target", "targetHash"), "/sitemap.xml"));
    await record("web allow snapshot llms.txt", page(pinnedTo(VIEW, { authenticatedAs: "snapshot" }), "/llms.txt"));
    await record("web TARGET_MISMATCH", page(pinnedTo(VIEW, { target: PROCEDURE })));
    await record("web TARGET_HASH_MISMATCH", page(pinnedTo(VIEW, { targetHash: "old" })));
    await record("web dry run", page(pinnedTo(VIEW, { dryRun: true })));
    await record("web HOST_CONTRACT unknown key", page({ ...pinnedTo(VIEW), extra: 1 }));
    await record("web HOST_CONTRACT missing user field", page(pinnedTo(VIEW, { user: without(user, "region") as HostProps["user"] })));
    await record("web unserved path", page(pinnedTo(VIEW), "/unknown.md"));
    await record("web head allow", head(pinnedTo(VIEW)));
    await record("web head dry run", head(pinnedTo(VIEW, { dryRun: true })));
    await record("web head TARGET_MISMATCH", head(pinnedTo(VIEW, { target: PROCEDURE })));
    await record("web head HOST_CONTRACT", head({ ...pinnedTo(VIEW), extra: 1 }));


    // What the host sends beyond the cases above: no props at all, a member whose target matched, snapshot reads.
    const member = (id: string, overrides: Partial<HostProps> = {}) => pinnedTo(id, { layer: "member", ...overrides });
    const bare = (path: string, init?: RequestInit) => new Request(ORIGIN + path, init);
    const rpcInit = (message: unknown) => ({
      method: "POST", body: JSON.stringify(message), headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    });
    const callMessage = (name: string, args: object = {}) => ({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
    await record("rest no ctx", async () => http(await api(bare("/api/views/public-records"), {})));
    await record("rest empty props", async () => http(await api(bare("/api/views/public-records"), {}, { props: {} })));
    await record("rest no props, write",
      async () => http(await api(bare("/api/write", { method: "POST", body: JSON.stringify(input) }), {}, { props: {} })));
    await record("mcp no props", async () => http(await tools(bare("/mcp", rpcInit(callMessage("public_records"))), {}, { props: {} })));
    await record("mcp no props, admin endpoint",
      async () => http(await tools(bare("/mcp/admin", rpcInit(callMessage("admin_records"))), {}, { props: {} })));
    await record("web no props", async () => http(await site.fetch(bare("/records.md"), {}, { props: {} })));
    await record("rest allow member with matched target", restCall(member(READ), "/api/views/public-records"));
    await record("mcp allow member with matched target", mcpCall(member(VIEW), "public_records"));
    await record("rest allow snapshot read", restCall(pinnedTo(READ, { authenticatedAs: "snapshot" }), "/api/views/public-records"));
    await record("mcp allow snapshot read", mcpCall(pinnedTo(VIEW, { authenticatedAs: "snapshot" }), "public_records"));
    const RENAME = "rest:POST /api/records/:id/rename";
    await record("rest STALE_CALLER snapshot write, path parameter",
      restCall(pinnedTo(RENAME, { authenticatedAs: "snapshot" }), `/api/records/${row.id}/rename`, { title: "renamed" }));
    await record("rest STALE_CALLER snapshot ref handler", restCall(pinnedTo(TOUCH, { authenticatedAs: "snapshot" }), "/api/touch", {}));
    await record("mcp STALE_CALLER snapshot ref handler", mcpCall(pinnedTo(REF, { authenticatedAs: "snapshot" }), "touch"));

    // MCP as a host uses it: one unbatched tools/call per request, with no initialize before it.
    await record("mcp allow admin endpoint without initialize", mcpCall(pinnedTo("view:admin-records"), "admin_records", {}, "/mcp/admin"));
    await record("mcp batch refused",
      async () => http(await tools(bare("/mcp", rpcInit([callMessage("public_records")])), {}, { props: { mantle: pinnedTo(VIEW) } })));
    await record("mcp deny resources/list", mcpCall(pinnedTo(VIEW), "", {}, "/mcp", "resources/list"));
    await record("mcp initialize", async () => http(await tools(bare("/mcp", rpcInit({
      jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "host", version: "1" } },
    })), {}, { props: { mantle: pinnedTo(VIEW) } })));

    // User fields: arity, enum, `{ all: true }` on scope and restrict terms, and a missing or empty value.
    const RESTRICTED = "rest:GET /api/views/restricted-records";
    const withUser = (id: string, values: object) => pinnedTo(id, { user: { id: "person", role: "editor", ...values } as HostProps["user"] });
    const userCases: Record<string, object> = {
      "region all": { region: { all: true }, stores: ["A"] }, "region and stores all": { region: { all: true }, stores: { all: true } },
      "region scalar": { region: "TW", stores: ["A"] }, "region outside enum": { region: ["XX"], stores: ["A"] },
      "region missing": { stores: ["A"] }, "region empty": { region: [], stores: ["A"] }, "stores missing": { region: ["TW"] },
      "region number": { region: [1], stores: ["A"] },
    };
    for (const [name, values] of Object.entries(userCases)) {
      await record(`rest user field: ${name}`, restCall(withUser(READ, values), "/api/views/public-records"));
      await record(`mcp user field: ${name}`, mcpCall(withUser(VIEW, values), "public_records"));
      await record(`web user field: ${name}`, page(withUser(VIEW, values)));
    }
    await record("rest restrict term: listed value",
      restCall(withUser(RESTRICTED, { region: ["TW"], stores: ["A"] }), "/api/views/restricted-records"));
    await record("rest restrict term: all refused",
      restCall(withUser(RESTRICTED, { region: { all: true }, stores: ["A"] }), "/api/views/restricted-records"));
    await record("mcp restrict term: all refused",
      mcpCall(withUser("view:restricted-records", { region: { all: true }, stores: ["A"] }), "restricted_records"));

    // A read-only Procedure: no manifest Procedure is proved read-only today, so a hand-written table carries the flag.
    const peekTargets = async () => Object.fromEntries(["rest:POST /api/peek", "rest:POST /api/poke", "procedure:peek", "procedure:poke"]
      .map(id => [id, { targetHash: `hash of ${id}`, opaque: false }]));
    const snapshot = (id: string) => base({ target: id, targetHash: `hash of ${id}`, authenticatedAs: "snapshot" });
    let ran = 0;
    const run = async () => { ran++; return { ok: true }; };
    const routes: Route<Database>[] = ["peek", "poke"].map(name => ({
      method: "POST", id: `rest:POST /api/${name}`, pattern: new RegExp(`^/api/${name}$`), readOnly: name === "peek",
      target: { kind: "procedure", name }, validate: raw => raw as Record<string, unknown>, run,
    }));
    const handTools: Tool<Database>[] = ["peek", "poke"].map(name => ({
      name, surface: "public", readOnly: name === "peek", target: { kind: "procedure", name }, description: name,
      inputSchema: { type: "object" }, validate: raw => raw as Record<string, unknown>, run,
    }));
    const handApi = kernelRest(routes, { ...shared, accessTargets: peekTargets, db: getDb });
    const handMcp = kernelMcp(handTools, { ...shared, accessTargets: peekTargets, db: getDb });
    for (const name of ["peek", "poke"]) {
      await record(`rest snapshot ${name}`,
        async () => http(await handApi(bare(`/api/${name}`, { method: "POST", body: "{}" }), {}, { props: { mantle: snapshot(`rest:POST /api/${name}`) } })));
      await record(`mcp snapshot ${name}`,
        async () => http(await handMcp(bare("/mcp", rpcInit(callMessage(name))), {}, { props: { mantle: snapshot(`procedure:${name}`) } })));
    }

    // Store writes under a snapshot caller.
    for (const layer of ["member", "admin"] as const) {
      const caller = hostCaller(base({ layer, authenticatedAs: "snapshot" }), { tenant: "example", fields });
      const collection = app.store(db, caller, { handlers }).collection("records");
      expect(await collection.findById(row.id)).not.toBeNull();
      const stale = { code: "STALE_CALLER", status: 403 };
      const before = db.query("SELECT version FROM records WHERE id=?").get(row.id) as { version: number };
      await expect(Promise.resolve(collection.insert({ region: "TW", store: "A", title: "snapshot" }))).rejects.toMatchObject(stale);
      await expect(Promise.resolve(collection.update(row.id, { title: "snapshot" }, { lock: before.version }))).rejects.toMatchObject(stale);
      await expect(Promise.resolve(collection.delete(row.id, { lock: before.version }))).rejects.toMatchObject(stale);
    }

    // The describe report the host reads, and matchTarget against the router.
    const { describe } = await describeOf("host-contract", [{ sourceId: "gateway.yaml", text: source }]);
    recorded["describe targets"] = stable(describe.targets.map(target => {
      const { id, targetHash, readOnly, surfaces, scope, restrict } = target._meta;
      return { name: target.name, _meta: { id, targetHash, readOnly, surfaces, scope, restrict } };
    }));
    const probe = prober(rest({ gateway: { tenant: "example" }, onAccess: (event: object) => { events.push(event); }, handlers, db: getDb }),
      events as { target: string; reason?: string }[], withUser("probe", { region: { all: true }, stores: { all: true } }));
    const routeIds = describe.targets.map(target => target._meta.id).filter(id => id.startsWith("rest:"));
    const resolved: Record<string, unknown> = {};
    for (const id of routeIds) {
      const [method, template] = id.slice(5).split(" ") as [string, string];
      for (const path of variants(template)) {
        const request = bare(path, { method, body: method === "GET" ? undefined : "{}" });
        const matched = matchTarget(describe, { surface: "rest", method, path: new URL(request.url).pathname })?.id ?? null;
        expect([path, matched]).toEqual([path, await probe(request)]);
        resolved[`${method} ${path}`] = matched;
      }
      expect(resolved[`${method} ${fill(template)}`]).toBe(id);
      expect(resolved[`${method} ${fill(template)}/`]).toBe(id);
    }
    recorded["matchTarget"] = resolved;

    // The behaviours the host depends on, stated one by one (the golden file pins the full answers).
    const codeOf = (name: string) => answers[name]!.body?.error?.code ?? answers[name]!.body?.result?.diagnostics?.[0]?.code;
    // 1. A stale target hash: 412 and `error.code`, on REST and MCP.
    for (const name of ["rest TARGET_HASH_MISMATCH", "mcp TARGET_HASH_MISMATCH"]) {
      expect(answers[name]!.status).toBe(412);
      expect(answers[name]!.body.error.code).toBe("TARGET_HASH_MISMATCH");
    }
    // 2. A host caller never sees 401 or a challenge.
    for (const [name, answer] of Object.entries(answers)) {
      if (/ no (ctx|props)| empty props/.test(name) || typeof answer !== "object" || !("status" in answer)) continue;
      expect([name, answer.status === 401, answer.wwwAuthenticate]).toEqual([name, false, null]);
    }
    expect(answers["rest 401 answered as 403"]).toMatchObject({ status: 403, body: { error: { code: "AUTH_DENIED" } } });
    expect(codeOf("mcp 401 answered as AUTH_DENIED")).toBe("AUTH_DENIED");
    // 3. Subjects of the two layers never collide.
    expect(hostCaller(base({ layer: "admin" }), { tenant: "example", fields }).subject).toBe("host:person");
    expect(hostCaller(base({ layer: "member" }), { tenant: "example", fields }).subject).toBe("person");
    for (const id of ["host:person", "system:person", "HOST:person", "System:person"])
      expect(() => hostCaller(base({ user: { ...user, id } }), { tenant: "example", fields })).toThrow(expect.objectContaining({ code: "HOST_CONTRACT", status: 412 }));
    // 4. A snapshot caller reads, and every write is refused with STALE_CALLER before a row changes.
    const staleWrites = ["rest STALE_CALLER snapshot write", "rest STALE_CALLER snapshot write, path parameter", "rest STALE_CALLER snapshot ref handler",
      "mcp STALE_CALLER snapshot write", "mcp STALE_CALLER snapshot ref handler", "rest snapshot poke", "mcp snapshot poke"];
    for (const name of staleWrites) expect([name, answers[name]!.status, codeOf(name)]).toEqual([name, 403, "STALE_CALLER"]);
    for (const name of ["rest allow snapshot read", "mcp allow snapshot read", "web allow snapshot llms.txt", "rest snapshot peek", "mcp snapshot peek"])
      expect([name, answers[name]!.status, codeOf(name)]).toEqual([name, 200, undefined]);
    expect(ran).toBe(2);
    // 5. One unbatched tools/call per request, without initialize; a batch or any other method is refused.
    for (const name of ["mcp allow admin read", "mcp allow admin endpoint without initialize", "mcp allow member with matched target"])
      expect(answers[name]).toMatchObject({ status: 200, body: { result: { isError: false } } });
    expect(answers["mcp batch refused"]!.status).toBeGreaterThanOrEqual(400);
    for (const name of ["mcp deny tools/list", "mcp deny resources/list"]) expect([name, answers[name]!.status]).toEqual([name, 403]);
    // 6. User fields: a missing or empty value is refused before any SQL; `{ all: true }` drops a scope term and is refused on a restrict term.
    for (const surface of ["rest", "mcp", "web"]) for (const field of ["region missing", "region empty", "stores missing"]) {
      const name = `${surface} user field: ${field}`;
      expect([name, codeOf(name), acquisitions[name]]).toEqual([name, "HOST_CONTRACT", 0]);
    }
    expect(answers["rest user field: region all"]!.body.rows.map((record: { title: string }) => record.title)).toEqual(["second", "changed"]);
    expect(answers["rest user field: region and stores all"]!.body.rows).toHaveLength(3);
    for (const name of ["rest restrict term: all refused", "mcp restrict term: all refused"])
      expect([name, codeOf(name), acquisitions[name]]).toEqual([name, "AUTH_DENIED", 0]);
    expect(answers["rest restrict term: listed value"]!.status).toBe(200);
    // Fail closed: the only writes that reached the table are the two allowed ones.
    expect(titles()).toEqual(["changed", "second", "third"]);

    const actual = JSON.stringify(recorded, null, 2) + "\n";
    if (process.env.UPDATE_HOST_CONTRACT) await writeFile(GOLDEN, actual);
    expect(JSON.parse(actual)).toEqual(JSON.parse(await readFile(GOLDEN, "utf8")));
  } finally { log.mockRestore(); db.close(); await rm(dir, { recursive: true, force: true }); }
}, 60_000);
