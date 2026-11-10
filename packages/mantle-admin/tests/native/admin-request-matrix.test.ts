/**
 * Admin's request decisions as one matrix: caller kind x route kind x request shape, with and without gateway mode and
 * application `authorize`. Every cell is recorded in `admin-request-matrix.golden.txt`: status, error envelope, the
 * headers a client reads, the body's top-level keys, database acquisition, caller resolution, every `authorize` call
 * and the `AccessEvent` given to `onAccess`. A change to Admin's caller, layer, Origin, path, freshness, pinning,
 * dry-run or authorization rules shows as a diff of that file.
 * Regenerate it with `UPDATE_MATRIX=1 bun test tests/native/admin-request-matrix.test.ts` and review the diff.
 */
import { expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Caller, Target } from "@aotter/mantle/contracts";
import { sdkFixtureCaller as fixtureCaller } from "../../../mantle/tests/apps/fixtures.js";
import { mantleProps, pinned } from "../../../mantle/tests/gateway-fixture.js";
import { admin } from "../../src/server/index.js";
import { entries } from "../../src/server/entries.js";
import { siteRoutes } from "../../src/server/site.js";
import { generateAdmin, writeAdminFixture } from "./generated-fixture.js";

const GOLDEN = resolve(import.meta.dir, "admin-request-matrix.golden.txt");
const ORIGIN = "https://app.test";
const manifest = (kind: string, name: string, spec: object) =>
  JSON.stringify({ apiVersion: "cms.mantle.aotter.net/v2", kind, metadata: { name }, spec });
const titled = { type: "object", required: ["title"], properties: { title: { type: "string" } } };
const noInput = { type: "object", additionalProperties: false };
const adminOnly = { auth: { all: ["ctx.admin"] } };
const operation = (name: string, handler: object) => [
  manifest("Procedure", name, { requires: adminOnly, input: noInput, output: { type: "object" }, handler }),
  manifest("Trigger", `${name}-admin`, { source: { kind: "mcp", surface: "admin" }, target: { procedure: name } }),
];
const source = [
  manifest("Schema", "records", { title: "Records", lifecycle: "publishing", schema: titled }),
  manifest("Schema", "notes", { title: "Notes", lifecycle: "operational", schema: titled }),
  manifest("View", "recent", { surface: "admin", sql: "SELECT id, title FROM notes ORDER BY id" }),
  ...operation("write", { sql: "UPDATE notes SET title = title RETURNING id" }),
  ...operation("peek", { sql: "UPDATE notes SET title = title RETURNING id" }),
  ...operation("touch", { ref: "app.touch" }),
].join("\n---\n");

/** A route kind: how a client reaches it, and the target id a host pins for it. */
interface RouteCase {
  readonly name: string;
  readonly method: string;
  /** Under /admin/api; `{id}` is the seeded entry. */
  readonly path: string;
  readonly id: string;
  /** A JSON body; `{version}` is the seeded entry's version. */
  readonly body?: string;
}
const routes: readonly RouteCase[] = [
  { name: "collection-list", method: "GET", path: "/entries?collection=records", id: "admin:GET /entries" },
  { name: "entry-read", method: "GET", path: "/entries/{id}?collection=records", id: "admin:GET /entries/:id" },
  {
    name: "entry-write",
    method: "PATCH",
    path: "/entries/{id}?collection=records",
    id: "admin:PATCH /entries/:id",
    body: '{"data":{"title":"changed"},"expectedVersion":{version}}',
  },
  {
    name: "entry-write-malformed-json",
    method: "PATCH",
    path: "/entries/{id}?collection=records",
    id: "admin:PATCH /entries/:id",
    body: "{",
  },
  {
    name: "entry-create",
    method: "POST",
    path: "/entries",
    id: "admin:POST /entries",
    body: '{"collection":"records","data":{"title":"new"}}',
  },
  {
    name: "publish",
    method: "POST",
    path: "/entries/{id}/publish?collection=records",
    id: "admin:POST /entries/:id/publish",
    body: "{}",
  },
  { name: "view-read", method: "GET", path: "/views/recent", id: "admin:GET /views/:name" },
  {
    name: "operation-write",
    method: "POST",
    path: "/operations/write",
    id: "admin:POST /operations/:name",
    body: "{}",
  },
  {
    name: "operation-read-only",
    method: "POST",
    path: "/operations/peek",
    id: "admin:POST /operations/:name",
    body: "{}",
  },
  { name: "operation-ref", method: "POST", path: "/operations/touch", id: "admin:POST /operations/:name", body: "{}" },
  {
    name: "site-settings-write",
    method: "PATCH",
    path: "/site-settings",
    id: "admin:PATCH /site-settings",
    body: '{"title":"T"}',
  },
  {
    name: "site-settings-malformed-json",
    method: "PATCH",
    path: "/site-settings",
    id: "admin:PATCH /site-settings",
    body: "{",
  },
  { name: "media", method: "GET", path: "/media", id: "admin:GET /media" },
  { name: "identity", method: "GET", path: "/members", id: "admin:GET /members" },
  { name: "me", method: "GET", path: "/me", id: "admin:GET /me" },
  { name: "custom-opaque", method: "PATCH", path: "/save", id: "admin:PATCH /save", body: "{}" },
  { name: "method-mismatch", method: "PUT", path: "/entries", id: "admin:PUT /entries", body: "{}" },
  { name: "unmatched-read", method: "GET", path: "/nope", id: "admin:GET /nope" },
  { name: "unmatched-write", method: "POST", path: "/nope", id: "admin:POST /nope", body: "{}" },
  { name: "base", method: "GET", path: "", id: "admin:GET " },
  { name: "malformed-slash", method: "GET", path: "/entries%2Fx", id: "admin:GET /entries%2Fx" },
  { name: "malformed-nul", method: "GET", path: "/entries%00", id: "admin:GET /entries%00" },
  { name: "malformed-escape", method: "GET", path: "/entries%zz", id: "admin:GET /entries%zz" },
];

const user = (subject: string, overrides: Partial<Extract<Caller, { kind: "user" }>>): Caller =>
  fixtureCaller({
    kind: "user",
    subject,
    role: null,
    scopes: [],
    credential: "session",
    credentialId: null,
    clientId: null,
    ...overrides,
  });
/** Callers an application's own resolver returns (gateway off). */
const localCallers: Readonly<Record<string, Caller>> = {
  "anonymous": { kind: "anonymous" },
  "user-session": user("u-session", {}),
  "user-oauth": user("u-oauth", { credential: "oauth", scopes: ["mcp"] }),
  "admin-session": user("u-admin", { role: "admin", admin: true }),
  "admin-oauth": user("u-admin-oauth", { role: "admin", admin: true, credential: "oauth", scopes: ["mcp"] }),
  "system": { kind: "system", reason: "matrix" },
};
/** Forwarded host contracts (gateway on); `undefined` is a request that carries no props. */
const hostCallers: Readonly<Record<string, Record<string, unknown> | undefined>> = {
  "no-props": undefined,
  "host-member": { layer: "member" },
  "host-admin": { layer: "admin" },
  "host-admin-session": { layer: "admin", credential: "session" },
  "host-admin-snapshot": { layer: "admin", authenticatedAs: "snapshot" },
};
const origins: Readonly<Record<string, Record<string, string>>> = {
  "same-origin": { origin: ORIGIN, "sec-fetch-site": "same-origin" },
  "cross-origin": { origin: "https://other.test", "sec-fetch-site": "cross-site" },
  "no-origin": {},
};
/** Host-only shapes: a same-origin request whose pin or dry-run flag differs. */
const pins: Readonly<Record<string, Record<string, unknown>>> = {
  "wrong-target": { target: "admin:GET /me" },
  "wrong-hash": { targetHash: "not-the-hash" },
  "dry-run": { dryRun: true },
};
type Authorization = "off" | "allow" | "deny";

test("Admin decides the same caller x route x request-shape matrix", async () => {
  const files = await generateAdmin("bun-sqlite", source);
  const dir = await mkdtemp(resolve(import.meta.dir, "../.admin-matrix-"));
  const log = spyOn(console, "error").mockImplementation((...a: unknown[]) => {
    if (process.env.DEBUG_MATRIX) process.stderr.write(String(a[1]?.stack ?? a[1]) + "\n");
  });
  let db: Database | undefined;
  try {
    await writeAdminFixture(dir, files);
    const app = await import(resolve(dir, "generated.ts")),
      { adminBindings } = await import(resolve(dir, "admin-bindings.ts")),
      { targets: generatedTargets } = await import(resolve(dir, "access-targets.ts"));
    const handlers = { touch: async () => ({ touched: true }) };
    const bindings = adminBindings({ handlers });
    // The compiler proves no manifest Procedure read-only, so the fixture marks `peek` as a generator would print it.
    const operations = bindings.operations.map((op: { name: string }) =>
      op.name === "peek" ? { ...op, readOnly: true } : op,
    );
    expect(operations.map((op: { name: string; readOnly?: boolean }) => `${op.name}:${!!op.readOnly}`)).toEqual([
      "write:false",
      "peek:true",
      "touch:false",
    ]);
    const accessTargets: Record<string, { targetHash: string; opaque: boolean }> = {
      ...generatedTargets,
      "admin:PATCH /save": { targetHash: "custom-save", opaque: true },
    };
    // The operations template is opaque because of the ref Procedure; only its variant lets a SQL Procedure dry-run.
    expect(accessTargets["admin:POST /operations/:name"]).toMatchObject({
      opaque: true,
      variants: [
        { id: "procedure:peek", opaque: false },
        { id: "procedure:touch", opaque: true },
        { id: "procedure:write", opaque: false },
      ],
    });

    // Per-cell observations.
    let current: Caller = { kind: "anonymous" },
      acquired = 0,
      resolutions = 0,
      entry = { id: "", version: 0 };
    const authorizations: string[] = [];
    const events: any[] = [];
    const seed = async () => {
      db?.close();
      db = new Database(":memory:");
      db.exec(files["schema.sql"]!);
      const system = app.store(db, { kind: "system", reason: "fixture" });
      const row = await system.collection("records").insert({ title: "first" });
      await system.collection("notes").insert({ title: "note" });
      entry = { id: row.id, version: Number(row.version) };
    };
    const siteOptions = {
      site: (handle: unknown) => ({
        read: async () => ({
          brand: "B",
          title: "T",
          description: "D",
          origin: "",
          locales: [],
          canonicalLocale: null,
          icons: [],
          media: { purposes: [] },
        }),
        updateSettings: async (input: Record<string, unknown>) => ({
          brand: "B",
          title: String(input.title),
          description: "D",
          handle: !!handle,
        }),
        media: () => ({ list: async () => ({ rows: [] }) }),
      }),
      media: {},
      identity: {
        directory: () => ({ listMembers: async () => ({ items: [], previousCursor: null, nextCursor: null }) }),
      },
    } as any;

    const mount = (gateway: boolean, authorization: Authorization) =>
      admin(bindings.metadata, bindings.views, operations, {
        ...siteOptions,
        ...(gateway ? { gateway: { tenant: "example" } } : {}),
        ...(authorization === "off"
          ? {}
          : {
              authorize: (target: Target) => {
                authorizations.push(`${target.kind}:${target.name}${target.action ? ":" + target.action : ""}`);
                return authorization === "allow";
              },
            }),
        accessTargets: async () => accessTargets,
        onAccess: (event: unknown) => {
          events.push(event);
        },
        db: () => {
          acquired++;
          return db!;
        },
        caller: () => {
          resolutions++;
          return current;
        },
        handlers,
        routes: [
          ...entries(bindings.schemas, bindings.adapter),
          ...siteRoutes(siteOptions),
          { method: "PATCH", path: "/save", run: () => ({ ok: true }) },
        ],
      });
    const mounts = new Map<string, ReturnType<typeof mount>>();
    const mounted = (gateway: boolean, authorization: Authorization) => {
      const key = `${gateway}:${authorization}`;
      if (!mounts.has(key)) mounts.set(key, mount(gateway, authorization));
      return mounts.get(key)!;
    };

    const normalize = (text: string) =>
      text.replaceAll(entry.id, "<id>").replace(/[0-9a-f]{64}/g, hash => {
        const id = Object.entries(accessTargets).find(([, meta]) => meta.targetHash === hash)?.[0];
        return id ? `<hash:${id}>` : "<hash>";
      });
    const describeResponse = async (response: Response | undefined): Promise<string> => {
      if (!response) return "unserved";
      const text = await response.text();
      let payload: any;
      try {
        payload = JSON.parse(text);
      } catch {}
      const parts = [`${response.status}`];
      if (payload && typeof payload === "object" && !Array.isArray(payload)) {
        const error = payload.error;
        if (response.status >= 400 && error && typeof error === "object") {
          const fields = ["code", "path", "target", "field"]
            .filter(key => error[key] !== undefined)
            .map(key => `${key}=${error[key]}`);
          parts.push(`error{${fields.join(" ")}${"message" in error ? " message" : ""}}`);
        }
        if (payload.dryRun === true) parts.push("dry-run");
        parts.push(`keys=${Object.keys(payload).sort().join(",") || "-"}`);
      } else parts.push(`body=${payload === undefined ? "text" : typeof payload}`);
      parts.push(`cache=${response.headers.get("cache-control") ?? "-"}`);
      if (response.headers.has("www-authenticate")) parts.push("www-authenticate");
      if (response.headers.has("allow")) parts.push(`allow=${response.headers.get("allow")}`);
      return normalize(parts.join(" "));
    };
    const describeEvent = (event: any) =>
      normalize(
        `${event.outcome}${event.reason ? ":" + event.reason : ""}${event.field ? ` field=${event.field}` : ""}` +
          `@${event.target} hash=${event.targetHash || "-"}${event.dryRun ? " dry" : ""}` +
          ` caller=${event.caller.kind}/${event.caller.layer}/${event.caller.subject || "-"}`,
      );

    const lines: string[] = [];
    const run = async (
      gateway: boolean,
      authorization: Authorization,
      callerName: string,
      shapeName: string,
      route: RouteCase,
    ) => {
      await seed();
      const props = gateway ? hostCallers[callerName] : undefined;
      const pin = pins[shapeName];
      const session = gateway
        ? props?.credential === "session"
        : "credential" in current && current.credential === "session";
      const headers: Record<string, string> = {
        ...(origins[shapeName] ?? origins["same-origin"]),
        ...(session ? { cookie: "session=fixture" } : {}),
        ...(route.body === undefined ? {} : { "content-type": "application/json" }),
      };
      let context: { props: Record<string, unknown> } | undefined;
      if (gateway) {
        if (!props) context = { props: {} };
        else {
          const contract: Record<string, unknown> = mantleProps(props);
          if (props.layer === "member") {
            delete contract.target;
            delete contract.targetHash;
          }
          context = { props: { mantle: { ...(await pinned(contract, accessTargets, route.id)), ...pin } } };
        }
      }
      acquired = 0;
      resolutions = 0;
      authorizations.length = 0;
      events.length = 0;
      const request = new Request(ORIGIN + "/admin/api" + route.path.replace("{id}", entry.id), {
        method: route.method,
        headers,
        ...(route.body === undefined ? {} : { body: route.body.replace("{version}", String(entry.version)) }),
      });
      const outcome = await describeResponse(await mounted(gateway, authorization)(request, {}, context));
      await new Promise(resolve => setTimeout(resolve, 0));
      const mode = `gateway=${gateway ? "on" : "off"} authorize=${authorization}`;
      lines.push(
        `${mode} caller=${callerName} shape=${shapeName} route=${route.name}`,
        `  ${outcome}`,
        `  db=${acquired} resolver=${resolutions} authorize=[${authorizations.join(",")}]`,
        `  event=${events.map(describeEvent).join(" | ") || "none"}`,
      );
    };

    for (const authorization of ["off", "allow", "deny"] as const) {
      for (const [callerName, caller] of Object.entries(localCallers)) {
        current = caller;
        for (const shapeName of Object.keys(origins))
          for (const route of routes) await run(false, authorization, callerName, shapeName, route);
      }
      current = { kind: "anonymous" };
      for (const [callerName, props] of Object.entries(hostCallers))
        for (const shapeName of [...Object.keys(origins), ...(props ? Object.keys(pins) : [])])
          for (const route of routes) await run(true, authorization, callerName, shapeName, route);
    }

    const actual = lines.join("\n") + "\n";
    if (process.env.UPDATE_MATRIX) await writeFile(GOLDEN, actual);
    expect(actual).toBe(await readFile(GOLDEN, "utf8"));
  } finally {
    log.mockRestore();
    db?.close();
    await rm(dir, { recursive: true, force: true });
  }
}, 300_000);
