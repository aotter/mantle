/**
 * docs/handbook/reference/authorization.md, "Caller conditions" and "Organization members and invitations": the page's
 * manifests are apps/org-members.yaml, its TypeScript typechecks against the built package, and src/authorize.ts and
 * src/org-mirror.ts run as written against a real Better Auth (emailAndPassword, admin, organization) on the D1 stand-in
 * over bun:sqlite, through the generated REST and MCP boundaries. The mirror's manifests also run on PostgreSQL.
 */
import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { SQL } from "bun";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { betterAuth } from "better-auth/minimal";
import { admin, organization } from "better-auth/plugins";
import { generateOrThrow, link, loadFixtureSources, writeGenerated } from "./apps/link.js";
import { d1Shim } from "./apps/d1-shim.js";
import { d1Adapter } from "../src/auth/adapter.js";
import { authLoader, resolveCaller, type AuthInstance } from "../src/auth/caller.js";
import { authSchemaSql } from "../src/infrastructure/authSchema.js";
import { userCaller } from "../src/kernel/user-caller.js";
import { ContractError } from "../src/kernel/contracts.js";

const base = resolve(import.meta.dir, ".."),
  page = resolve(base, "../../docs/handbook/reference/authorization.md");
const documents = (text: string) =>
  text
    .split(/\n---\n/)
    .map(doc => doc.replace(/^(#.*\n)+/, "").trim())
    .filter(doc => !/kind: Trigger/.test(doc));
/** The page's TypeScript files: blocks that start with `// src/<name>.ts`. */
const sourceBlocks = async () =>
  [...(await readFile(page, "utf8")).matchAll(/^```ts\n(\/\/ (src\/[\w-]+\.ts)[^\n]*\n[\s\S]*?)^```$/gm)].map(
    match => ({ file: match[2]!, code: match[1]! }),
  );

test("the page's organization manifests are the org-members fixture", async () => {
  const section = (await readFile(page, "utf8"))
    .split("### Organization members and invitations")[1]!
    .split(/\n##+ /)[0]!;
  expect([...section.matchAll(/^```yaml\n([\s\S]*?)^```$/gm)].flatMap(match => documents(match[1]!))).toEqual(
    documents((await loadFixtureSources("org-members.yaml"))[0]!.text),
  );
});

test("the page's TypeScript typechecks against the built package and the generated cloudflare-d1 code", async () => {
  const project = await mkdtemp(join(tmpdir(), "mantle-authorization-docs-")),
    modules = (name: string) => join(base, "node_modules", name);
  try {
    for (const [name, target] of [
      ["@aotter/mantle", base],
      ["better-auth", modules("better-auth")],
      ["@types/node", modules("@types/node")],
      ["@cloudflare/workers-types", modules("@cloudflare/workers-types")],
    ] as const) {
      await mkdir(dirname(join(project, "node_modules", name)), { recursive: true });
      await symlink(target, join(project, "node_modules", name), "dir");
    }
    await writeFile(join(project, "package.json"), '{"type":"module"}\n');
    await writeGenerated(
      join(project, "generated"),
      await generateOrThrow("cloudflare-d1", await loadFixtureSources("org-members.yaml")),
      false,
    );
    for (const { file, code } of await sourceBlocks()) {
      await mkdir(dirname(join(project, file)), { recursive: true });
      await writeFile(join(project, file), code);
    }
    await writeFile(
      join(project, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          target: "ES2022",
          module: "NodeNext",
          moduleResolution: "NodeNext",
          strict: true,
          noEmit: true,
          skipLibCheck: true,
          types: ["@cloudflare/workers-types", "node"],
        },
        include: ["src/**/*.ts", "generated/**/*.ts"],
      }),
    );
    const tsc = spawnSync(process.execPath, [resolve(base, "../../node_modules/typescript/bin/tsc"), "-p", project], {
      encoding: "utf8",
    });
    expect(tsc.stdout + tsc.stderr).toBe("");
  } finally {
    await rm(project, { recursive: true, force: true });
  }
}, 60000);

const ORIGIN = "http://local";

describe("Better Auth organization hooks and authorize, as the page writes them", () => {
  let app: Awaited<ReturnType<typeof makeApp>>;
  beforeAll(async () => {
    app = await makeApp();
  });
  afterAll(async () => {
    await rm(app.dir, { recursive: true, force: true });
  });

  async function makeApp() {
    const sqlite = new Database(":memory:"),
      d1 = d1Shim(sqlite);
    const files = await generateOrThrow(
      "cloudflare-d1",
      await loadFixtureSources("org-members.yaml", "caller-conditions.yaml"),
    );
    await mkdir(resolve(import.meta.dir, "apps/.generated"), { recursive: true });
    const dir = await mkdtemp(resolve(import.meta.dir, "apps/.generated/authorization-"));
    await writeGenerated(join(dir, "generated"), files);
    await mkdir(join(dir, "src"));
    for (const { file, code } of await sourceBlocks())
      await writeFile(
        join(dir, file),
        link(code.replace('"@aotter/mantle/auth/adapter"', JSON.stringify(resolve(base, "src/auth/adapter.ts")))),
      );
    const generated = await import(join(dir, "generated/generated.ts"));
    const { organizationMirror } = await import(join(dir, "src/org-mirror.ts"));
    const { authorizeWith } = await import(join(dir, "src/authorize.ts"));
    const { rest } = await import(join(dir, "generated/rest.ts"));
    const { mcp } = await import(join(dir, "generated/mcp.ts"));

    let failMirror = false;
    const mirror = organizationMirror(
      () => {
        if (failMirror) throw new Error("mirror database unavailable");
        return d1;
      },
      () => auth.$context,
    );
    const options = {
      secret: "s".repeat(32),
      baseURL: ORIGIN,
      database: d1Adapter(d1 as never),
      emailAndPassword: { enabled: true },
      user: { additionalFields: { orgIds: { type: "string[]" as const, required: false, input: false } } },
      plugins: [admin(), organization({ organizationHooks: mirror.hooks })],
    };
    for (const text of authSchemaSql(options as never, "sqlite")) sqlite.run(text);
    sqlite.exec(files["schema.sql"]!);
    const auth = betterAuth(options);
    const loader = authLoader(async () => auth as unknown as AuthInstance);
    const surface = {
      db: (env: { DB: unknown }) => env.DB,
      caller: (request: Request) => resolveCaller(request, loader, { fields: generated.userFields }),
      handlers: {},
      authorize: authorizeWith(() => auth.$context),
    };
    const api = rest(surface),
      tools = mcp(surface);

    /** The Cookie header a browser would send next: the last value of each Set-Cookie, without the cleared ones. */
    const cookieOf = (headers: Headers) =>
      [
        ...new Map(
          headers.getSetCookie().map(line => line.split(";")[0]!.split(/=(.*)/s).slice(0, 2) as [string, string]),
        ),
      ]
        .filter(([, value]) => value)
        .map(([name, value]) => `${name}=${value}`)
        .join("; ");
    async function signUp(name: string) {
      const { headers, response } = await auth.api.signUpEmail({
        // Better Auth's body type asks for orgIds although it is input: false.
        body: { email: `${name}@example.test`, password: "correct horse battery", name } as never,
        returnHeaders: true,
      });
      return { id: response.user.id as string, headers: new Headers({ cookie: cookieOf(headers) }) };
    }
    const request = (path: string, who: { headers: Headers }, body?: unknown, extra: Record<string, string> = {}) =>
      new Request(`${ORIGIN}${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          cookie: who.headers.get("cookie")!,
          ...(path === "/mcp" ? {} : { origin: ORIGIN }),
          "sec-fetch-site": "same-origin",
          ...(body === undefined ? {} : { "content-type": "application/json" }),
          ...extra,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    const call = async (path: string, who: { headers: Headers }, body?: unknown) => {
      const response = (await api(request(path, who, body), { DB: d1 }))!;
      return { status: response.status, body: (await response.json()) as any };
    };
    const tool = async (who: { headers: Headers }, method: string, params: Record<string, unknown> = {}) => {
      const response = await tools(
        request(
          "/mcp",
          who,
          {
            jsonrpc: "2.0",
            id: 1,
            method,
            params: {
              ...params,
              _meta: {
                "io.modelcontextprotocol/protocolVersion": "2026-07-28",
                "io.modelcontextprotocol/clientCapabilities": {},
              },
            },
          },
          {
            accept: "application/json, text/event-stream",
            "mcp-protocol-version": "2026-07-28",
            "mcp-method": method,
            ...(typeof params.name === "string" ? { "mcp-name": params.name } : {}),
          },
        ),
        { DB: d1 },
      );
      const text = await response.text();
      return {
        status: response.status,
        body: JSON.parse(text.startsWith("event:") ? text.split("data: ")[1]!.split("\n")[0]! : text),
      };
    };
    const members = async (who: { headers: Headers }, orgId: string) => {
      const { status, body } = await call(`/api/views/organization-members?orgId=${orgId}`, who);
      return status === 200
        ? body.rows.map((row: { kind: string; email: string; role: string }) => `${row.kind}:${row.email}:${row.role}`)
        : `${status} ${body.error?.code}`;
    };
    const orgIdsOf = (id: string) =>
      JSON.parse((sqlite.query("SELECT orgIds FROM user WHERE id = ?").get(id) as { orgIds: string }).orgIds ?? "null");
    return {
      dir,
      cookieOf,
      sqlite,
      d1,
      auth,
      mirror,
      generated,
      surface,
      signUp,
      call,
      tool,
      members,
      orgIdsOf,
      failMirror: (fail: boolean) => {
        failMirror = fail;
      },
    };
  }

  test("organization hooks keep the mirror and orgIds current; the View lists only the caller's organizations", async () => {
    const { auth, signUp, members, orgIdsOf, sqlite } = app;
    const [alice, bob, carol] = [await signUp("alice"), await signUp("bob"), await signUp("carol")];
    const acme = await auth.api.createOrganization({ body: { name: "Acme", slug: "acme" }, headers: alice.headers });
    expect(orgIdsOf(alice.id)).toEqual([acme!.id]);
    expect(await members(alice, acme!.id)).toEqual(["member:alice@example.test:owner"]);

    const invited = await auth.api.createInvitation({
      body: { email: "bob@example.test", role: "member", organizationId: acme!.id },
      headers: alice.headers,
    });
    expect(await members(alice, acme!.id)).toEqual([
      "member:alice@example.test:owner",
      "invitation:bob@example.test:member",
    ]);
    expect(await members(bob, acme!.id)).toBe("403 AUTH_DENIED");

    await auth.api.acceptInvitation({ body: { invitationId: invited.id }, headers: bob.headers });
    expect(orgIdsOf(bob.id)).toEqual([acme!.id]);
    expect(await members(bob, acme!.id)).toEqual(["member:alice@example.test:owner", "member:bob@example.test:member"]);

    const bobMember = (sqlite.query("SELECT id FROM member WHERE userId = ?").get(bob.id) as { id: string }).id;
    await auth.api.updateMemberRole({
      body: { memberId: bobMember, role: "admin", organizationId: acme!.id },
      headers: alice.headers,
    });
    expect(await members(alice, acme!.id)).toContain("member:bob@example.test:admin");

    const carolInvite = await auth.api.createInvitation({
      body: { email: "carol@example.test", role: "member", organizationId: acme!.id },
      headers: alice.headers,
    });
    expect(await members(alice, acme!.id)).toContain("invitation:carol@example.test:member");
    await auth.api.cancelInvitation({ body: { invitationId: carolInvite.id }, headers: alice.headers });
    expect(await members(alice, acme!.id)).toEqual([
      "member:alice@example.test:owner",
      "member:bob@example.test:admin",
    ]);

    // carol's own organization gives her an orgIds value, but not acme's rows.
    const beta = await auth.api.createOrganization({ body: { name: "Beta", slug: "beta" }, headers: carol.headers });
    expect(await members(carol, acme!.id)).toEqual([]);
    expect(await members(carol, beta!.id)).toEqual(["member:carol@example.test:owner"]);

    // Paging, and MCP's query tool over the same View.
    const page = await app.call(`/api/views/organization-members?orgId=${acme!.id}&limit=1`, alice);
    expect([page.body.rows.length, typeof page.body.nextCursor]).toEqual([1, "string"]);
    const listed = await app.tool(alice, "tools/call", {
      name: "organization_members",
      arguments: { orgId: acme!.id },
    });
    expect(listed.body.result.structuredContent.rows.map((row: { email: string }) => row.email)).toEqual([
      "alice@example.test",
      "bob@example.test",
    ]);

    // Removing bob: his next request no longer reaches acme.
    await auth.api.removeMember({
      body: { memberIdOrEmail: bobMember, organizationId: acme!.id },
      headers: alice.headers,
    });
    expect([orgIdsOf(bob.id), await members(bob, acme!.id)]).toEqual([[], "403 AUTH_DENIED"]);
    expect(await members(alice, acme!.id)).toEqual(["member:alice@example.test:owner"]);

    // A failed mirror write: the endpoint fails, the invitation stays committed, and a sync repairs the mirror.
    app.failMirror(true);
    const quiet = spyOn(console, "error").mockImplementation(() => {});
    const failed = await auth.handler(
      new Request(`${ORIGIN}/api/auth/organization/invite-member`, {
        method: "POST",
        headers: { cookie: alice.headers.get("cookie")!, origin: ORIGIN, "content-type": "application/json" },
        body: JSON.stringify({ email: "dave@example.test", role: "member", organizationId: acme!.id }),
      }),
    );
    app.failMirror(false);
    quiet.mockRestore();
    expect(failed.status).toBe(500);
    expect(
      (sqlite.query("SELECT count(*) AS n FROM invitation WHERE email = 'dave@example.test'").get() as { n: number }).n,
    ).toBe(1);
    expect(await members(alice, acme!.id)).toEqual(["member:alice@example.test:owner"]);
    // A stale row the hooks never saw is removed by the same sync.
    sqlite.run(
      `INSERT INTO org_members (id, version, created_at, updated_at, orgid, entry, kind, email, name, role) VALUES ('stale', 1, 0, 0, '${acme!.id}', 'member:ghost', 'member', 'ghost@example.test', '', 'member')`,
    );
    await app.mirror.syncOrganization(acme!.id);
    expect(await members(alice, acme!.id)).toEqual([
      "member:alice@example.test:owner",
      "invitation:dave@example.test:member",
    ]);

    // Deleting the organization removes its rows and its id from every former member.
    await auth.api.deleteOrganization({ body: { organizationId: acme!.id }, headers: alice.headers });
    expect(orgIdsOf(alice.id)).toEqual([]);
    expect(
      (sqlite.query(`SELECT count(*) AS n FROM org_members WHERE orgid = '${acme!.id}'`).get() as { n: number }).n,
    ).toBe(0);
  });

  test("authorize: impersonation, email verification and a recent sign-in, on REST and MCP", async () => {
    const { auth, signUp, call, tool, sqlite, cookieOf } = app;
    const erin = await signUp("erin");
    const deny = (message: string, target: string) => ({
      status: 403,
      body: { error: { code: "AUTH_DENIED", message, path: target } },
    });
    expect(await call("/api/notes", erin, { body: "first" })).toEqual(
      deny("Verify your email address first.", "procedure/add-note"),
    );
    sqlite.run("UPDATE user SET emailVerified = 1 WHERE id = ?", [erin.id]);
    expect((await call("/api/notes", erin, { body: "first" })).status).toBe(200);
    expect((await call("/api/workspace/delete", erin, {})).status).toBe(200);

    // The sign-in is now older than ten minutes: the sensitive target refuses, others still pass.
    sqlite.run("UPDATE session SET createdAt = ? WHERE userId = ?", [
      new Date(Date.now() - 11 * 60 * 1000).toISOString(),
      erin.id,
    ]);
    expect(await call("/api/workspace/delete", erin, {})).toEqual(
      deny("Sign in again to do this.", "procedure/delete-workspace"),
    );
    expect((await call("/api/notes", erin, { body: "second" })).status).toBe(200);

    // An admin impersonating erin reads what she reads and writes nothing, on REST and MCP.
    const root = await signUp("root");
    sqlite.run("UPDATE user SET role = 'admin' WHERE id = ?", [root.id]);
    const { headers } = await auth.api.impersonateUser({
      body: { userId: erin.id },
      headers: root.headers,
      returnHeaders: true,
    });
    const impersonating = { headers: new Headers({ cookie: cookieOf(headers) }) };
    const read = await call("/api/views/my-notes", impersonating);
    expect([read.status, read.body.rows.map((row: { body: string }) => row.body)]).toEqual([200, ["second"]]);
    const refused = deny("Not while impersonating: sign in as yourself.", "procedure/add-note");
    expect(await call("/api/notes", impersonating, { body: "as erin" })).toEqual(refused);
    const viaMcp = await tool(impersonating, "tools/call", { name: "add_note", arguments: { body: "as erin" } });
    expect([viaMcp.status, viaMcp.body.error]).toEqual([403, refused.body.error]);
    const list = await tool(impersonating, "tools/list");
    // The refused writes are not listed (erin's empty orgIds also hides the organization View).
    expect(list.body.result.tools.map((t: { name: string }) => t.name)).toEqual(["my_notes"]);
  });

  test("a 429 thrown from authorize reaches REST and MCP as 403 AUTH_DENIED", async () => {
    const { signUp } = app;
    const { rest } = await import(join(app.dir, "generated/rest.ts"));
    const { mcp } = await import(join(app.dir, "generated/mcp.ts"));
    const limited = {
      ...app.surface,
      authorize: async () => {
        throw new ContractError("RATE_LIMITED", "Too many requests.", "", { status: 429, fields: { retryAfter: 60 } });
      },
    };
    const user = await signUp("frank");
    const headers = {
      cookie: user.headers.get("cookie")!,
      origin: ORIGIN,
      "sec-fetch-site": "same-origin",
      "content-type": "application/json",
    };
    const viaRest = (await rest(limited)(
      new Request(`${ORIGIN}/api/notes`, { method: "POST", headers, body: JSON.stringify({ body: "x" }) }),
      { DB: app.d1 },
    ))!;
    expect([viaRest.status, await viaRest.json()]).toEqual([
      403,
      { error: { code: "AUTH_DENIED", message: "Target is not authorized.", path: "procedure/add-note" } },
    ]);
    const viaMcp = await mcp(limited)(
      new Request(`${ORIGIN}/mcp`, {
        method: "POST",
        headers: {
          cookie: headers.cookie,
          "sec-fetch-site": "same-origin",
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "mcp-protocol-version": "2026-07-28",
          "mcp-method": "tools/call",
          "mcp-name": "add_note",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "add_note",
            arguments: { body: "x" },
            _meta: {
              "io.modelcontextprotocol/protocolVersion": "2026-07-28",
              "io.modelcontextprotocol/clientCapabilities": {},
            },
          },
        }),
      }),
      { DB: app.d1 },
    );
    expect([viaMcp.status, (await viaMcp.json()).error]).toEqual([
      403,
      { code: "AUTH_DENIED", message: "Target is not authorized.", path: "procedure/add-note" },
    ]);
  });
});

(process.env.MANTLE_NEXT_BUN_PG_URL ? test : test.skip)(
  "PostgreSQL: the mirror's Procedures run as the system caller and the View lists only the caller's organizations",
  async () => {
    const files = await generateOrThrow("bun-postgres", await loadFixtureSources("org-members.yaml"));
    await mkdir(resolve(import.meta.dir, "apps/.generated"), { recursive: true });
    const dir = await mkdtemp(resolve(import.meta.dir, "apps/.generated/org-members-pg-")),
      sql = new SQL(process.env.MANTLE_NEXT_BUN_PG_URL!, { max: 1 }),
      schema = "org_members_" + crypto.randomUUID().replaceAll("-", "");
    try {
      await writeGenerated(dir, files);
      await sql.unsafe(`CREATE SCHEMA ${schema}`);
      await sql.unsafe(`SET search_path TO ${schema}`);
      await sql.unsafe(files["schema.sql"]!);
      const generated = await import(join(dir, "generated.ts"));
      const put = (await import(join(dir, "procedures/put-org-entry.ts"))).default;
      const drop = (await import(join(dir, "procedures/drop-org-entry.ts"))).default;
      const { rest } = await import(join(dir, "rest.ts"));
      const system = { kind: "system", reason: "organization mirror" } as const;
      for (const [orgId, entry, email, role] of [
        ["acme", "member:a", "a@example.test", "owner"],
        ["acme", "member:b", "b@example.test", "member"],
        ["beta", "member:c", "c@example.test", "owner"],
      ])
        await put(sql, system, { orgId, entry, kind: "member", email, name: "", role });
      await put(sql, system, {
        orgId: "acme",
        entry: "member:b",
        kind: "member",
        email: "b@example.test",
        name: "",
        role: "admin",
      });
      await drop(sql, system, { orgId: "beta", entry: "member:c" });
      const api = rest({
        db: () => sql,
        caller: (request: Request) =>
          userCaller(
            { id: "a", orgIds: request.headers.get("x-orgs")!.split(",").filter(Boolean) },
            { fields: generated.userFields, credential: "oauth" },
          ),
        handlers: {},
      });
      const list = async (orgs: string, orgId: string) => {
        const response = (await api(
          new Request(`${ORIGIN}/api/views/organization-members?orgId=${orgId}`, { headers: { "x-orgs": orgs } }),
        ))!;
        const body = (await response.json()) as any;
        return response.status === 200
          ? body.rows.map((row: { email: string; role: string }) => `${row.email}:${row.role}`)
          : `${response.status} ${body.error.code}`;
      };
      expect(await list("acme", "acme")).toEqual(["a@example.test:owner", "b@example.test:admin"]);
      expect(await list("beta", "acme")).toEqual([]);
      expect(await list("acme,beta", "beta")).toEqual([]);
      expect(await list("", "acme")).toBe("403 AUTH_DENIED");
    } finally {
      await rm(dir, { recursive: true, force: true });
      await sql.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => {});
      await sql.close();
    }
  },
  30000,
);
