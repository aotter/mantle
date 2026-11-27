import { test, expect, afterAll } from "bun:test";
import { admin, phoneNumber, username } from "better-auth/plugins";
import { jwt } from "better-auth/plugins/jwt";
import { oauthProvider } from "@better-auth/oauth-provider";
import { generateFromSources } from "../src/infrastructure/generateAuth.js";
import { oauthGrantRevocation } from "../src/auth/oauth.js";
const sources = {
  sources: [
    {
      sourceId: "notes.json",
      text: JSON.stringify({
        apiVersion: "cms.mantle.aotter.net/v2",
        kind: "Schema",
        metadata: { name: "notes" },
        spec: {
          title: "Notes",
          lifecycle: "operational",
          schema: { type: "object", required: ["label"], properties: { label: { type: "string" } } },
        },
      }),
    },
  ],
};
const tables = (prefix: string) => ({
  user: { modelName: `${prefix}_user` },
  session: { modelName: `${prefix}_session` },
  account: { modelName: `${prefix}_account` },
  verification: { modelName: `${prefix}_verification` },
});
const sql = (files: Readonly<Record<string, string>>) =>
  Object.entries(files)
    .filter(([name]) => name.endsWith(".sql"))
    .map(([, text]) => text)
    .join("\n");

test("every --auth instance gets its tables; a table two instances define differently is refused", async () => {
  const both = await generateFromSources({
    target: "bun-postgres",
    sources,
    auth: [{ ...tables("staff"), plugins: [admin()] }, tables("customer")],
  });
  if (!both.ok) throw Error(JSON.stringify(both.diagnostics));
  for (const table of ["staff_user", "staff_session", "customer_user", "customer_session"])
    expect(sql(both.files)).toContain(`CREATE TABLE IF NOT EXISTS "${table}"`);
  const same = await generateFromSources({ target: "bun-postgres", sources, auth: [{}, {}] });
  expect(same.ok).toBe(true);
  await expect(
    generateFromSources({ target: "bun-postgres", sources, auth: [{ plugins: [admin()] }, {}] }),
  ).rejects.toThrow('table "user" differently');
});

test("an OAuth provider without oauthGrantRevocation() is refused at generate", async () => {
  const provider = { id: "oauth-provider" } as never,
    revocation = oauthGrantRevocation() as never;
  await expect(generateFromSources({ target: "bun-sqlite", sources, auth: { plugins: [provider] } })).rejects.toThrow(
    "without oauthGrantRevocation()",
  );
  expect(
    (await generateFromSources({ target: "bun-sqlite", sources, auth: { plugins: [revocation, provider] } })).ok,
  ).toBe(true);
});

// The mappings below are written into Better Auth's shared plugin schemas; put the defaults back for the other test files in this process.
afterAll(() => {
  jwt({ schema: { jwks: { modelName: "jwks" } } });
  admin({ schema: { user: { fields: { role: "role", banReason: "banReason" } } } });
  phoneNumber({ sendOTP() {}, schema: { user: { fields: { phoneNumber: "phoneNumber" } } } });
});
const instance = (prefix: string, plugins: unknown[]) => ({ ...tables(prefix), plugins }) as never;
const own = <P extends { schema?: unknown }>(plugin: P): P => ({ ...plugin, schema: structuredClone(plugin.schema) });

test("instances with default plugins and distinct core table names are accepted", async () => {
  const result = await generateFromSources({
    target: "bun-postgres",
    sources,
    auth: [instance("a", [admin(), jwt()]), instance("b", [admin(), jwt()])],
  });
  expect(result.ok).toBe(true);
});

test("explicit plugin mappings in every instance, each with its own schema copy, are accepted", async () => {
  const build = (prefix: string, model: string) =>
    instance(prefix, [
      own(jwt({ schema: { jwks: { modelName: model } } })),
      own(
        oauthProvider({
          loginPage: "/login",
          consentPage: "/consent",
          schema: Object.fromEntries(
            [
              "oauthClient",
              "oauthResource",
              "oauthClientResource",
              "oauthRefreshToken",
              "oauthAccessToken",
              "oauthConsent",
              "oauthClientAssertion",
            ].map(table => [table, { modelName: `${prefix}_${table}` }]),
          ),
        }),
      ),
      oauthGrantRevocation(),
    ]);
  const result = await generateFromSources({
    target: "bun-postgres",
    sources,
    auth: [build("a", "jwks"), build("b", "b_jwks")],
  });
  if (!result.ok) throw Error(JSON.stringify(result.diagnostics));
  expect(sql(result.files)).toContain('"b_jwks"');
});

test("a mapped plugin next to the default one keeps each instance's own names", async () => {
  const result = await generateFromSources({
    target: "bun-postgres",
    sources,
    auth: [
      instance("a", [admin({ schema: { user: { fields: { role: "staff_role" } } } }), jwt()]),
      instance("b", [admin(), jwt({ schema: { jwks: { modelName: "b_jwks" } } })]),
    ],
  });
  if (!result.ok) throw Error(JSON.stringify(result.diagnostics));
  expect(sql(result.files)).toMatch(/CREATE TABLE IF NOT EXISTS "a_user" \([^;]*"staff_role" text/);
  expect(sql(result.files)).toMatch(/CREATE TABLE IF NOT EXISTS "b_user" \([^;]*"role" text/);
  expect(sql(result.files)).toContain('CREATE TABLE IF NOT EXISTS "jwks"');
  expect(sql(result.files)).toContain('CREATE TABLE IF NOT EXISTS "b_jwks"');
});

// Better Auth 1.7.19+ ("Schema overrides no longer leak between instances of the same plugin"): a
// mapped factory call returns a fresh schema, so a later default call no longer inherits the mapping.
test("an instance built after a mapped one keeps the plugin's default names", async () => {
  const mappedFirst = own(phoneNumber({ sendOTP() {}, schema: { user: { fields: { phoneNumber: "a_phone" } } } }));
  const unmapped = own(phoneNumber({ sendOTP() {} }));
  const result = await generateFromSources({
    target: "bun-postgres",
    sources,
    auth: [instance("a", [mappedFirst]), instance("b", [unmapped])],
  });
  if (!result.ok) throw Error(JSON.stringify(result.diagnostics));
  expect(sql(result.files)).toMatch(/CREATE TABLE IF NOT EXISTS "a_user" \([^;]*"a_phone" text UNIQUE/);
  expect(sql(result.files)).toMatch(/CREATE TABLE IF NOT EXISTS "b_user" \([^;]*"phoneNumber" text UNIQUE/);
});

test("plugins that build their schema per call may map the same name in each instance", async () => {
  const build = (prefix: string) =>
    instance(prefix, [username({ schema: { user: { fields: { username: "user_name" } } } })]);
  expect((await generateFromSources({ target: "bun-postgres", sources, auth: [build("a"), build("b")] })).ok).toBe(
    true,
  );
});

test("an identical explicit mapping in two instances is accepted", async () => {
  const build = (prefix: string) =>
    instance(prefix, [admin({ schema: { user: { fields: { banReason: "ban_reason" } } } })]);
  const result = await generateFromSources({ target: "bun-postgres", sources, auth: [build("a"), build("b")] });
  if (!result.ok) throw Error(JSON.stringify(result.diagnostics));
  expect(sql(result.files)).toMatch(/CREATE TABLE IF NOT EXISTS "a_user" \([^;]*"ban_reason" text/);
  expect(sql(result.files)).toMatch(/CREATE TABLE IF NOT EXISTS "b_user" \([^;]*"ban_reason" text/);
});

test("a mapped factory result is its own schema, so it needs no copy next to a mapped copy", async () => {
  const copied = own(admin({ schema: { user: { fields: { role: "b_role" } } } }));
  const mapped = admin({ schema: { user: { fields: { role: "a_role" } } } });
  const result = await generateFromSources({
    target: "bun-postgres",
    sources,
    auth: [instance("a", [mapped]), instance("b", [copied])],
  });
  if (!result.ok) throw Error(JSON.stringify(result.diagnostics));
  expect(sql(result.files)).toMatch(/CREATE TABLE IF NOT EXISTS "a_user" \([^;]*"a_role" text/);
  expect(sql(result.files)).toMatch(/CREATE TABLE IF NOT EXISTS "b_user" \([^;]*"b_role" text/);
});
