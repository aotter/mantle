/**
 * One decision matrix for the three request surfaces: caller kind x target x request shape, with and without gateway
 * mode, application `authorize` and dry runs. Every cell is recorded in `request-pipeline-matrix.golden.txt`, so a
 * change to any surface's caller, Origin, scope, `requires` or authorization step shows as a diff of that file.
 * Regenerate it with `UPDATE_MATRIX=1 bun test tests/request-pipeline-matrix.test.ts` and review the diff.
 */
import { expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Caller } from "../src/kernel/contracts.js";
import type { HostProps } from "../src/kernel/host-caller.js";
import { fixtureCaller } from "./apps/fixtures.js";
import { generateOrThrow, writeGenerated } from "./apps/link.js";
import { mantleProps, pinned } from "./gateway-fixture.js";

const GOLDEN = resolve(import.meta.dir, "request-pipeline-matrix.golden.txt");
const ORIGIN = "https://app.test";

const manifest = (kind: string, name: string, spec: object) =>
  JSON.stringify({ apiVersion: "cms.mantle.aotter.net/v2", kind, metadata: { name }, spec });
const requires = (...all: unknown[]) => ({ auth: { all } });
const noInput = { type: "object", additionalProperties: false };
const procedure = (name: string, guard: object, sql: string) => [
  manifest("Procedure", name, { requires: guard, input: noInput, output: { type: "object" }, handler: { sql } }),
  manifest("Trigger", `${name}-http`, { source: { kind: "http", method: "POST", path: `/api/${name}` }, target: { procedure: name } }),
  manifest("Trigger", `${name}-mcp`, { source: { kind: "mcp", surface: "public" }, target: { procedure: name } }),
];
const SELECT = "SELECT id, title FROM notes ORDER BY id";
const UPDATE = "UPDATE notes SET title = title RETURNING id";
const source = [
  manifest("Schema", "notes", {
    title: "Notes", lifecycle: "operational",
    schema: { type: "object", required: ["title"], properties: { title: { type: "string" } } },
  }),
  manifest("View", "open", { surface: "public", sql: SELECT }),
  manifest("View", "members", { surface: "public", requires: requires("ctx.user"), sql: SELECT }),
  manifest("View", "staff", { surface: "public", requires: requires("ctx.admin"), sql: SELECT }),
  manifest("View", "audit", { surface: "admin", sql: SELECT }),
  ...procedure("peek", requires("ctx.user"), UPDATE),
  ...procedure("write", requires("ctx.user"), UPDATE),
  ...procedure("scoped", requires("ctx.user", { "ctx.auth.scope": "notes:write" }), UPDATE),
  ...procedure("manage", requires("ctx.admin"), UPDATE),
].join("\n---\n");

/** A target and how each surface reaches it; a surface that does not serve it is absent. */
interface TargetCase {
  readonly name: string;
  readonly kind: "view" | "procedure";
  readonly rest?: string;
  readonly mcp?: string;
  readonly web?: string;
}
const targets: readonly TargetCase[] = [
  { name: "open", kind: "view", rest: "/api/views/open", mcp: "/mcp", web: "/open" },
  { name: "members", kind: "view", rest: "/api/views/members", mcp: "/mcp", web: "/members" },
  { name: "staff", kind: "view", rest: "/api/views/staff", mcp: "/mcp", web: "/staff" },
  { name: "audit", kind: "view", mcp: "/mcp/admin" },
  { name: "peek", kind: "procedure", rest: "/api/peek", mcp: "/mcp" },
  { name: "write", kind: "procedure", rest: "/api/write", mcp: "/mcp" },
  { name: "scoped", kind: "procedure", rest: "/api/scoped", mcp: "/mcp" },
  { name: "manage", kind: "procedure", rest: "/api/manage", mcp: "/mcp" },
];

const user = (subject: string, overrides: Partial<Extract<Caller, { kind: "user" }>>): Caller =>
  fixtureCaller({ kind: "user", subject, role: null, scopes: [], credential: "session", credentialId: null, clientId: null, ...overrides });
/** Callers an application's own resolver returns (gateway off). */
const localCallers: Readonly<Record<string, Caller>> = {
  "anonymous": { kind: "anonymous" },
  "user-session": user("u-session", {}),
  "user-oauth": user("u-oauth", { credential: "oauth", scopes: ["mcp", "notes:write"] }),
  "user-oauth-mcp-only": user("u-narrow", { credential: "oauth", scopes: ["mcp"] }),
  "user-oauth-no-scope": user("u-bare", { credential: "oauth", scopes: [] }),
  "admin-session": user("u-admin", { role: "admin", admin: true }),
  "system": { kind: "system", reason: "matrix" },
};
/** Forwarded host contracts (gateway on); `undefined` is a request that carries no props. */
const hostCallers: Readonly<Record<string, Partial<HostProps> | undefined>> = {
  "no-props": undefined,
  "host-member": { layer: "member" },
  "host-member-session": { layer: "member", credential: "session" },
  "host-member-snapshot": { layer: "member", authenticatedAs: "snapshot" },
  "host-member-dry-run": { layer: "member", dryRun: true },
  "host-admin": { layer: "admin" },
  "host-admin-session": { layer: "admin", credential: "session" },
  "host-admin-snapshot": { layer: "admin", authenticatedAs: "snapshot" },
  "host-admin-dry-run": { layer: "admin", dryRun: true },
};
const shapes: Readonly<Record<string, Record<string, string>>> = {
  "same-origin": { origin: ORIGIN, "sec-fetch-site": "same-origin" },
  "cross-origin": { origin: "https://other.test", "sec-fetch-site": "cross-site" },
  "no-origin": {},
};
type Surface = "rest" | "mcp" | "web";
type Authorization = "off" | "allow" | "deny";

/** What a surface decided, without its transport: `allow`, `dry-run`, or `deny:<code>`. */
interface Outcome { readonly decision: string; readonly detail: string }
const errorOf = (payload: any): { code: string; where: string } | undefined => payload?.error && typeof payload.error.code === "string"
  ? { code: payload.error.code, where: payload.error.path ?? (payload.error.target ? `@${payload.error.target}` : "") }
  : undefined;
const denied = (error: { code: string; where: string }, transport: string): Outcome =>
  ({ decision: `deny:${error.code}`, detail: `${transport} at=${error.where || "-"}` });

async function httpOutcome(response: Response | undefined): Promise<Outcome> {
  if (!response) return { decision: "unserved", detail: "undefined" };
  const challenge = response.headers.has("www-authenticate") ? " challenge" : "";
  const text = await response.text();
  let payload: any;
  try { payload = JSON.parse(text.startsWith("event:") ? text.split("data: ")[1]!.split("\n")[0]! : text); } catch {}
  const transport = `http ${response.status}${challenge}`;
  if (response.status >= 400) {
    const error = errorOf(payload);
    return error ? denied(error, transport) : { decision: `deny:HTTP_${response.status}`, detail: transport };
  }
  if (payload?.dryRun === true) return { decision: "dry-run", detail: transport };
  // MCP answers a tool's own failure inside a successful JSON-RPC result.
  if (payload?.jsonrpc === "2.0") {
    if (payload.error) return { decision: `deny:RPC_${payload.error.code}`, detail: transport };
    const result = payload.result;
    if (result?.isError) {
      const diagnostic = result.structuredContent?.diagnostics?.[0] ?? JSON.parse(result.content[0].text).diagnostics[0];
      return denied(errorOf({ error: diagnostic })!, `${transport} tool-error`);
    }
    if (result?.structuredContent?.dryRun === true) return { decision: "dry-run", detail: `${transport} tool-result` };
    return { decision: "allow", detail: `${transport} tool-result` };
  }
  return { decision: "allow", detail: transport };
}

test("REST, MCP and web decide the same caller x target x request-shape matrix", async () => {
  const files = await generateOrThrow("bun-sqlite", [{ sourceId: "matrix.yaml", text: source }]);
  const dir = await mkdtemp(resolve(import.meta.dir, ".matrix-")), db = new Database(":memory:");
  const log = spyOn(console, "error").mockImplementation(() => {});
  try {
    // The compiler proves no manifest Procedure read-only today (media tools and app-composed tables carry the flag),
    // so the fixture marks `peek` the way the generator would print it.
    const peek = 'target: {"kind":"procedure","name":"peek"}';
    const marked = Object.fromEntries(Object.entries(files).map(([name, text]) =>
      [name, name === "rest.ts" || name === "mcp.ts" ? text.replace(peek, `readOnly: true, ${peek}`) : text]));
    expect(marked["rest.ts"]).toContain("readOnly: true");
    expect(marked["mcp.ts"]).toContain("readOnly: true");
    await writeGenerated(dir, marked);
    db.exec(files["schema.sql"]!);
    const app = await import(resolve(dir, "generated.ts"));
    await app.store(db, { kind: "system", reason: "fixture" }).collection("notes").insert({ title: "first" });
    const { rest } = await import(resolve(dir, "rest.ts")), { mcp } = await import(resolve(dir, "mcp.ts"));
    const { web } = await import(resolve(dir, "web.ts")), { targets: accessTargets } = await import(resolve(dir, "access-targets.ts"));

    // Per-cell observations of the side effects a decision must precede.
    let current: Caller = { kind: "anonymous" }, acquired = 0, authorizations = 0, resolutions = 0;
    const events: { outcome: string; reason?: string; target: string; dryRun: boolean }[] = [];
    const pages = Object.fromEntries(targets.filter(target => target.web).map(target =>
      [target.web!, { view: target.name, list: target.name, markdown: "title" }]));

    const mount = (gateway: boolean, authorization: Authorization) => {
      const shared = {
        ...(gateway ? { gateway: { tenant: "example" } } : {}),
        ...(authorization === "off" ? {} : { authorize: () => { authorizations++; return authorization === "allow"; } }),
        caller: () => { resolutions++; return current; },
        onAccess: (event: typeof events[number]) => { events.push(event); },
      };
      const getDb = () => { acquired++; return db; };
      // A getter counts the web surface's use of its handle the way `db()` counts REST and MCP acquisitions.
      const webDb = new Proxy(db, {
        get(target, key) {
          if (key === "query" || key === "prepare") acquired++;
          const value = Reflect.get(target, key);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      return {
        rest: rest({ ...shared, db: getDb }),
        mcp: mcp({ ...shared, db: getDb, allowedOrigins: [ORIGIN, "https://other.test"] }),
        web: web({ ...shared, db: webDb, origin: ORIGIN, title: "Matrix", description: "Matrix", pages }),
      };
    };
    const mounts = new Map<string, ReturnType<typeof mount>>();
    const mounted = (gateway: boolean, authorization: Authorization) => {
      const key = `${gateway}:${authorization}`;
      if (!mounts.has(key)) mounts.set(key, mount(gateway, authorization));
      return mounts.get(key)!;
    };

    const lines: string[] = [], divergent: string[] = [], acquiredBeforeDenial: string[] = [];
    const run = async (gateway: boolean, authorization: Authorization, callerName: string, shapeName: string, target: TargetCase) => {
      const mode = `gateway=${gateway ? "on" : "off"} authorize=${authorization}`;
      const cell = `${mode} caller=${callerName} shape=${shapeName} target=${target.name}`;
      const props = gateway ? hostCallers[callerName] : undefined;
      const session = gateway ? props?.credential === "session" : "credential" in current && current.credential === "session";
      const headers = { ...shapes[shapeName], ...(session ? { cookie: "session=fixture" } : {}) };
      // The admin layer must pin its target; a member forwards none. Workers pass `{}` props on ordinary requests.
      const context = async (id: string) => {
        if (!gateway) return undefined;
        if (!props) return { props: {} };
        const contract: Partial<HostProps> = mantleProps(props);
        if (props.layer === "member") {
          delete (contract as { target?: string }).target;
          delete (contract as { targetHash?: string }).targetHash;
        }
        return { props: { mantle: await pinned(contract, accessTargets, id) } };
      };
      const surfaces = mounted(gateway, authorization);
      const decisions: string[] = [], parts: string[] = [];
      const observe = async (surface: Surface, call: () => Promise<Outcome>) => {
        acquired = 0; authorizations = 0; resolutions = 0; events.length = 0;
        const outcome = await call();
        await new Promise(resolve => setTimeout(resolve, 0));
        const observed = events.map(event =>
          `${event.outcome}${event.reason ? `:${event.reason}` : ""}@${event.target}${event.dryRun ? " dry" : ""}`);
        const event = observed.join(",") || "none";
        decisions.push(outcome.decision);
        if (outcome.decision.startsWith("deny:") && acquired > 0) acquiredBeforeDenial.push(`${cell} ${surface}`);
        const effects = `db=${acquired > 0 ? 1 : 0} authorize=${authorizations} resolver=${resolutions} event=${event}`;
        parts.push(`  ${surface}: ${outcome.decision} [${outcome.detail}] ${effects}`);
      };
      if (target.rest) {
        const method = target.kind === "view" ? "GET" : "POST";
        const request = new Request(ORIGIN + target.rest, { method, headers, ...(method === "POST" ? { body: "{}" } : {}) });
        await observe("rest", async () => httpOutcome(await surfaces.rest(request, {}, await context(`rest:${method} ${target.rest}`))));
      }
      if (target.mcp) {
        const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: target.name, arguments: {} } });
        const transport = { "content-type": "application/json", accept: "application/json, text/event-stream" };
        const request = new Request(ORIGIN + target.mcp, { method: "POST", body, headers: { ...transport, ...headers } });
        await observe("mcp", async () => httpOutcome(await surfaces.mcp(request, {}, await context(`${target.kind}:${target.name}`))));
      }
      if (target.web) {
        const page = () => new Request(ORIGIN + target.web + ".md", { headers });
        await observe("web", async () => httpOutcome(await surfaces.web.fetch(page(), {}, await context(`view:${target.name}`))));
        // `head` renders tags for an HTML shell: it answers a string, or rejects.
        let head: string;
        try {
          const tags = await surfaces.web.head(new Request(ORIGIN + target.web, { headers }), {}, await context(`view:${target.name}`));
          head = tags ? "tags" : "empty";
        }
        catch (error) { head = `throws:${(error as { code?: string }).code ?? "Error"}`; }
        parts.push(`  web.head: ${head}`);
      }
      lines.push(cell, ...parts);
      if (new Set(decisions).size > 1) divergent.push(cell);
    };

    for (const authorization of ["off", "allow", "deny"] as const) {
      for (const [callerName, caller] of Object.entries(localCallers)) {
        current = caller;
        for (const shapeName of Object.keys(shapes))
          for (const target of targets) await run(false, authorization, callerName, shapeName, target);
      }
      current = { kind: "anonymous" };
      for (const callerName of Object.keys(hostCallers)) {
        for (const shapeName of Object.keys(shapes))
          for (const target of targets) await run(true, authorization, callerName, shapeName, target);
      }
    }

    const actual = lines.join("\n") + "\n";
    if (process.env.UPDATE_MATRIX) await writeFile(GOLDEN, actual);
    expect(actual).toBe(await readFile(GOLDEN, "utf8"));

    // Every surface refuses before it acquires a database handle. The one exception is the fixture's own: `peek` is
    // marked read-only by hand but still writes, so a snapshot host caller passes the pipeline's freshness step and
    // the generated Procedure's own freshness guard refuses it.
    expect(acquiredBeforeDenial.filter(cell => !/ caller=host-(member|admin)-snapshot .* target=peek /.test(cell))).toEqual([]);

    // Surfaces must agree on a cell unless one of these documented rules explains the difference.
    const unexplained = divergent.filter(cell => !divergences.some(rule => rule.test(cell)));
    expect(unexplained).toEqual([]);
    for (const rule of divergences) expect(divergent.some(cell => rule.test(cell)), `stale divergence rule ${rule}`).toBe(true);
  } finally { log.mockRestore(); db.close(); await rm(dir, { recursive: true, force: true }); }
}, 120_000);

/** Cells where the surfaces answer differently on purpose (or by a recorded inconsistency); each must still occur. */
const divergences: readonly RegExp[] = [
  // MCP is an endpoint for people and their agents: it refuses a system caller before any tool, REST and web decide by `requires`.
  / caller=system /,
  // MCP's scope floor (`requiredScopes`, default `["mcp"]`) applies to every bearer credential; REST and web have none.
  / caller=user-oauth-no-scope /,
];
