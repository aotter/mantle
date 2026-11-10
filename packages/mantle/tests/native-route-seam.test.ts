/**
 * The native REST seam a mounted surface such as Admin builds on: mount admission, a route's access variant, dry run
 * through `prepare`, and an authorize target computed from the decoded request with `authorize` bound to the caller.
 */
import { expect, test } from "bun:test";
import { ContractError, type AccessEvent, type Caller, type Target } from "../src/kernel/contracts.js";
import { nativeRest, rest, type Route } from "../src/kernel/rest.js";
import { fixtureCaller } from "./apps/fixtures.js";
import { mantleProps } from "./gateway-fixture.js";

const user = (overrides: Partial<Extract<Caller, { kind: "user" }>> = {}): Caller =>
  fixtureCaller({
    kind: "user",
    subject: "u",
    role: null,
    scopes: [],
    credential: "oauth",
    credentialId: null,
    clientId: null,
    ...overrides,
  });
const post = (path: string, body = "{}") =>
  new Request("https://app.test" + path, { method: "POST", headers: { "content-type": "application/json" }, body });
const hostProps = (target: string, overrides: object = {}) => ({
  props: { mantle: { ...mantleProps(), target, targetHash: target + "-hash", ...overrides } },
});
const errorOf = async (response: Response | undefined): Promise<Record<string, unknown>> =>
  ((await response!.json()) as { error: Record<string, unknown> }).error;
const flush = () => new Promise(resolve => setTimeout(resolve, 0));

test("admission runs after the caller is resolved and before the Origin rule and the guard", async () => {
  const steps: string[] = [];
  let current: Caller = { kind: "anonymous" };
  const api = nativeRest(
    [
      {
        method: "POST",
        pattern: /^\/api\/x$/,
        target: { kind: "procedure", name: "x" },
        handle: async () => {
          steps.push("handle");
          return { ok: true };
        },
      },
    ],
    {
      db: () => null,
      caller: () => {
        steps.push("caller");
        return current;
      },
      authorize: () => {
        steps.push("authorize");
        return true;
      },
      admission: caller => {
        steps.push("admission");
        if (caller.kind === "anonymous") throw new ContractError("UNAUTHENTICATED", "Sign in.", "mount");
        if (!("admin" in caller && caller.admin))
          return Response.json({ error: { code: "AUTH_DENIED" }, minimumRole: "admin" }, { status: 403 });
        return undefined;
      },
    },
  );
  const anonymous = await api(post("/api/x"), {});
  expect([anonymous!.status, (await errorOf(anonymous)).path]).toEqual([401, "mount"]);
  expect(steps.splice(0)).toEqual(["caller", "admission"]);

  current = user();
  const refused = await api(post("/api/x"), {});
  expect([refused!.status, await refused!.json()]).toEqual([
    403,
    { error: { code: "AUTH_DENIED" }, minimumRole: "admin" },
  ]);
  expect(steps.splice(0)).toEqual(["caller", "admission"]);

  // An admitted session caller still meets the Origin rule, after admission and before the guard.
  current = user({ admin: true, role: "admin", credential: "session" });
  const crossOrigin = await api(
    new Request("https://app.test/api/x", { method: "POST", headers: { origin: "https://other.test" }, body: "{}" }),
    {},
  );
  expect([crossOrigin!.status, (await errorOf(crossOrigin)).path]).toEqual([403, "request:origin"]);
  expect(steps.splice(0)).toEqual(["caller", "admission"]);

  current = user({ admin: true, role: "admin" });
  expect((await api(post("/api/x"), {}))!.status).toBe(200);
  expect(steps.splice(0)).toEqual(["caller", "admission", "authorize", "handle"]);

  // Routing comes first: an unmatched path or a method mismatch resolves no caller and admits nobody.
  expect((await api(post("/api/y"), {}))!.status).toBe(404);
  expect((await api(new Request("https://app.test/api/x"), {}))!.status).toBe(405);
  expect(steps).toEqual([]);
});

test("a refusal returned by admission is the request's access event, against the matched route", async () => {
  const events: AccessEvent[] = [];
  const api = nativeRest(
    [{ method: "POST", id: "mount:POST /x", pattern: /^\/api\/x$/, handle: async () => ({ ok: true }) }],
    {
      db: () => null,
      gateway: { tenant: "example" },
      accessTargets: async () => ({ "mount:POST /x": { targetHash: "mount:POST /x-hash", opaque: true } }),
      onAccess: event => {
        events.push(event);
      },
      admission: caller =>
        caller.kind === "host" ? undefined : Response.json({ error: { code: "AUTH_DENIED" } }, { status: 403 }),
    },
  );
  expect((await api(post("/api/x"), {}, hostProps("mount:POST /x", { layer: "member" })))!.status).toBe(403);
  await flush();
  expect(events.at(-1)).toMatchObject({
    target: "mount:POST /x",
    targetHash: "mount:POST /x-hash",
    outcome: "deny",
    reason: "AUTH_DENIED",
  });
  expect((await api(post("/api/x"), {}, hostProps("mount:POST /x")))!.status).toBe(200);
  await flush();
  expect(events.at(-1)).toMatchObject({ target: "mount:POST /x", outcome: "allow" });
});

test("a route's access variant decides a host caller's dry run; prepare answers it without a database", async () => {
  let acquired = 0,
    handled = 0;
  const prepared: string[] = [];
  const id = "mount:POST /ops/:name";
  const route = (name: string, extra: Partial<Route<null>> = {}): Route<null> => ({
    method: "POST",
    id,
    pattern: new RegExp(`^/api/ops/${name}$`),
    variant: `procedure:${name}`,
    prepare: (_request, _env, _caller, _params, input) => {
      prepared.push(`${name}:${JSON.stringify(input)}`);
      if (input?.bad) throw new ContractError("INPUT_VALIDATION_FAILED", "Bad input.", "mount");
    },
    handle: async (_request, _env, getDb) => {
      getDb();
      handled++;
      return { ok: true };
    },
    ...extra,
  });
  const api = nativeRest(
    [
      route("safe"),
      route("opaque"),
      route("unprepared", { prepare: undefined }),
      route("read", { readOnly: true }),
      { method: "POST", id: "mount:POST /raw", pattern: /^\/api\/raw$/, handle: async () => ({}) },
    ],
    {
      db: () => {
        acquired++;
        return null;
      },
      gateway: { tenant: "example" },
      accessTargets: async () => ({
        [id]: {
          targetHash: id + "-hash",
          opaque: true,
          variants: [
            { id: "procedure:safe", opaque: false },
            { id: "procedure:opaque", opaque: true },
            { id: "procedure:unprepared", opaque: false },
            { id: "procedure:read", opaque: false },
          ],
        },
        "mount:POST /raw": { targetHash: "mount:POST /raw-hash", opaque: false },
      }),
    },
  );
  const dry = (path: string, target: string, body?: string, extra: object = {}) =>
    api(post(path, body), {}, hostProps(target, { dryRun: true, ...extra }));

  const answered = await dry("/api/ops/safe", id, '{"a":1}');
  expect(answered!.status).toBe(200);
  expect(await answered!.json()).toMatchObject({ dryRun: true, event: { target: id, outcome: "allow", dryRun: true } });
  expect(prepared.splice(0)).toEqual(['safe:{"a":1}']);

  const invalid = await dry("/api/ops/safe", id, '{"bad":true}');
  expect([invalid!.status, (await errorOf(invalid)).code]).toEqual([400, "INPUT_VALIDATION_FAILED"]);
  prepared.length = 0;

  // The variant's own policy refuses before anything is read.
  const opaque = await dry("/api/ops/opaque", id);
  expect([opaque!.status, (await errorOf(opaque)).code]).toEqual([412, "DRY_RUN_UNSUPPORTED"]);

  // A route without prepare refuses even a malformed body, which it never decodes.
  for (const [path, target] of [
    ["/api/ops/unprepared", id],
    ["/api/raw", "mount:POST /raw"],
  ]) {
    const refused = await dry(path!, target!, "{");
    expect([refused!.status, (await errorOf(refused)).code]).toEqual([412, "DRY_RUN_UNSUPPORTED"]);
  }
  expect([prepared, handled, acquired]).toEqual([[], 0, 0]);

  // Freshness follows the route's own read-only flag: a snapshot caller may read, not write.
  const snapshot = { authenticatedAs: "snapshot" };
  expect((await api(post("/api/ops/read"), {}, hostProps(id, snapshot)))!.status).toBe(200);
  const stale = await api(post("/api/ops/safe"), {}, hostProps(id, snapshot));
  expect([stale!.status, (await errorOf(stale)).code]).toEqual([403, "STALE_CALLER"]);
});

test("a computed target is authorized from the decoded request; handlers get authorize bound to the caller", async () => {
  const decided: string[] = [];
  let allow = true,
    seen: Record<string, unknown> | undefined;
  const caller = user({ admin: true, role: "admin" });
  const route: Route<null> = {
    method: "POST",
    pattern: /^\/api\/items\/([^/]+)$/,
    keys: ["id"],
    target: (_request, _env, c, params, input) => {
      expect(c).toBe(caller);
      return { kind: "schema", name: `${input?.collection}:${params.id}`, action: "update" };
    },
    handle: async (_request, _env, _getDb, _caller, _params, _handlers, input, access) => {
      seen = input;
      return {
        related: await access.authorized({ kind: "schema", name: "related", action: "read" }),
        other: await access.authorize({ kind: "view", name: "other" }).then(
          () => "allowed",
          (error: ContractError) => `${error.code} ${error.path}`,
        ),
      };
    },
  };
  const authorize = (target: Target, c: Caller) => {
    expect(c).toBe(caller);
    decided.push(`${target.kind}:${target.name}`);
    return allow || target.name === "related";
  };
  const api = nativeRest([route], { db: () => null, caller: () => caller, authorize });
  const call = (body: string) => api(post("/api/items/7", body), {});

  const ok = await call('{"collection":"records"}');
  expect(await ok!.json()).toEqual({ related: true, other: "allowed" });
  expect(seen).toEqual({ collection: "records" });
  expect(decided.splice(0)).toEqual(["schema:records:7", "schema:related", "view:other"]);

  allow = false;
  const denied = await call('{"collection":"records"}');
  expect([denied!.status, await errorOf(denied)]).toMatchObject([
    403,
    { code: "AUTH_DENIED", path: "schema/records:7" },
  ]);
  expect(decided.splice(0)).toEqual(["schema:records:7"]);

  // The body is decoded before the computed target, so malformed JSON is refused without asking `authorize`.
  expect((await call("{"))!.status).toBe(400);
  expect(decided).toEqual([]);

  // Without application `authorize`, every target is authorized.
  const open = nativeRest([route], { db: () => null, caller: () => caller });
  expect(await (await open(post("/api/items/7", '{"collection":"records"}'), {}))!.json()).toEqual({
    related: true,
    other: "allowed",
  });
});

test("a mount's base owns its paths: unmatched, method mismatch and malformed are answered under it only", async () => {
  let resolved = 0;
  const api = nativeRest(
    [
      {
        method: "GET",
        pattern: /^\/admin\/api\/items\/([^/]+)\/?$/,
        keys: ["id"],
        readOnly: true,
        handle: async () => ({}),
      },
    ],
    {
      db: () => null,
      base: "/admin/api",
      caller: () => {
        resolved++;
        return user();
      },
    },
  );
  const ask = async (path: string, method = "GET") => {
    const response = await api(new Request("https://app.test" + path, { method }), {});
    return response ? `${response.status} ${(await errorOf(response))?.code ?? ""}`.trim() : "unserved";
  };
  expect(await ask("/admin/api/items/1")).toBe("200");
  resolved = 0;
  expect(await ask("/admin/api/nope")).toBe("404 NOT_FOUND");
  expect(await ask("/admin/api")).toBe("404 NOT_FOUND");
  expect(await ask("/admin/api/items/1", "POST")).toBe("405 METHOD_NOT_ALLOWED");
  // A native mount takes no encoded separators or NUL, even inside a parameter.
  for (const path of [
    "/admin/api/items/a%2Fb",
    "/admin/api/items/a%5cb",
    "/admin/api/items%00",
    "/admin/api/items/%zz",
  ])
    expect(await ask(path)).toBe("400 INPUT_VALIDATION_FAILED");
  expect(resolved).toBe(0);
  // Outside the base nothing is answered, not even a malformed path.
  for (const path of ["/admin/apix", "/admin/%61pi/items/1", "/api/nope", "/other/%zz", "/other/a%2Fb"])
    expect(await ask(path)).toBe("unserved");
});

test("generated REST under the default base still accepts an encoded slash inside a path parameter", async () => {
  let seen: unknown;
  const route: Route<null> = {
    method: "POST",
    pattern: /^\/api\/items\/([^/]+)$/,
    keys: ["id"],
    validate: raw => (seen = raw) as Record<string, unknown>,
    run: async () => ({ ok: true }),
  };
  const api = rest([route], { db: () => null, caller: () => user() });
  const response = await api(post("/api/items/a%2Fb"), {});
  expect(response!.status).toBe(200);
  expect(seen).toEqual({ id: "a/b" });
  expect((await api(post("/api/items%00"), {}))!.status).toBe(404);
});
