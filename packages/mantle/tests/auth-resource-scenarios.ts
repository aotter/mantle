/** Lookup-only resource provisioning oracle, shared with SQLite/D1 and native PostgreSQL. */
import assert from "node:assert/strict";
import type { BetterAuthOptions } from "@better-auth/core";
import { betterAuth } from "better-auth/minimal";
import { jwt } from "better-auth/plugins";
import { oauthProvider } from "@better-auth/oauth-provider";
import { authLoader, resolveCaller } from "../src/auth/caller.js";
import { authSchemaSql } from "../src/infrastructure/authSchema.js";

const register = (auth: ReturnType<typeof betterAuth>) => (auth.api as unknown as { registerOAuthClient(input: { body: { client_name: string; redirect_uris: string[] } }): Promise<{ client_id: string }> }).registerOAuthClient({ body: { client_name: "Fixture", redirect_uris: ["https://client.example/callback"] } });
type Run = (text: string, values?: unknown[]) => Promise<Record<string, unknown>[]>;
export async function verifyOAuthResources(database: BetterAuthOptions["database"], dialect: "sqlite" | "postgres", run: Run, statements: string[]) {
  for (const renamed of [false, true]) {
    const identifier = "https://resource.example/mcp?label=it's", table = renamed ? "configured_resources" : "oauthResource";
    const options: BetterAuthOptions = {
      baseURL: "https://resource.example/api/auth", secret: "resource-secret-0123456789-0123456789", database,
      plugins: [jwt({ disableSettingJwtHeader: true }), oauthProvider({
        loginPage: "/login", consentPage: "/consent", scopes: ["mcp"], resources: [{ identifier, name: "App's MCP", accessTokenTtl: 300, allowedScopes: ["mcp"], customClaims: { tier: "basic" }, signingAlgorithm: "unsupported" as never }],
        clientRegistrationDefaultResources: [identifier], allowDynamicClientRegistration: true, allowUnauthenticatedClientRegistration: true,
        ...(renamed ? { schema: { oauthResource: { modelName: table, fields: { identifier: "resource_uri", name: "resource_name" } } } } : {}),
      })],
    };
    const sql = authSchemaSql(options, dialect);
    assert.deepEqual(authSchemaSql(options, dialect), sql, "generation is deterministic");
    for (const text of sql) await run(text);
    const auth = betterAuth(options);
    statements.length = 0;
    const { adapter } = await auth.$context;
    assert.equal(statements.length, 0, "fresh isolate auth init does no resource read/write");
    assert.deepEqual(authSchemaSql(options, dialect), sql, "runtime seed suppression leaves DDL unchanged");
    statements.length = 0;
    await assert.rejects(resolveCaller(new Request("https://resource.example/mcp", { headers: { authorization: "Bearer invalid" } }), authLoader(async () => auth as never), { audience: identifier }), { code: "UNAUTHENTICATED" });
    assert.equal(statements.length, 0, "bearer verification does not query or seed resources");
    assert.equal(sql.some(text => /^INSERT/.test(text)), false, "no environment-dependent seeds in schema");
    const resourceSql = () => statements.filter(text => text.includes(`"${table}"`));
    statements.length = 0;
    const clients = await Promise.all([register(auth), register(auth), register(auth)]);
    assert.ok(clients.every(client => client.client_id), "first concurrent OAuth flow works on an empty table");
    assert.equal(resourceSql().filter(text => /^INSERT/.test(text)).length, 1);
    assert.match(resourceSql().find(text => /^INSERT/.test(text))!, /ON CONFLICT DO NOTHING/);
    for (const phase of ["second", "fresh isolate"]) {
      const instance = phase === "second" ? auth : betterAuth(options);
      statements.length = 0;
      assert.ok((await register(instance)).client_id);
      assert.equal(resourceSql().length, 1, phase);
      assert.match(resourceSql()[0]!, /^SELECT/);
    }
    const resource = await adapter.findOne<{ name: string; accessTokenTtl: number; allowedScopes: string[]; customClaims: unknown; signingAlgorithm: string | null; createdAt: Date }>({ model: "oauthResource", where: [{ field: "identifier", value: identifier }] });
    assert.equal(resource?.name, "App's MCP"); assert.equal(resource?.accessTokenTtl, 300);
    assert.deepEqual(resource?.allowedScopes, ["mcp"]); assert.deepEqual(resource?.customClaims, { tier: "basic" });
    assert.equal(resource?.signingAlgorithm, null, "unsupported signing algorithm is dropped");
    assert.ok(resource?.createdAt instanceof Date && Number.isFinite(resource.createdAt.getTime()));
    if (dialect === "sqlite") assert.match((await run(`SELECT "createdAt" FROM "${table}"`))[0]!.createdAt as string, /^\d{4}-\d{2}-\d{2}T.*Z$/);
    await run(`UPDATE "${table}" SET "accessTokenTtl" = 120`);
    assert.ok((await register(betterAuth(options))).client_id);
    assert.equal((await adapter.findOne<{ accessTokenTtl: number }>({ model: "oauthResource", where: [{ field: "identifier", value: identifier }] }))?.accessTokenTtl, 120, "preserve policy edits");
    statements.length = 0;
    assert.equal(await adapter.findOne({ model: "oauthResource", where: [{ field: "identifier", value: "https://unknown.example/mcp" }] }), null);
    assert.equal(statements.some(text => /^INSERT/.test(text)), false);
    await run(`DELETE FROM "${table}"`);
    const contexts = await Promise.all([betterAuth(options).$context, betterAuth(options).$context]);
    const lookup = (a: typeof adapter) => a.findOne({ model: "oauthResource", where: [{ field: "identifier", value: identifier }] });
    assert.ok((await Promise.all(contexts.map(context => lookup(context.adapter)))).every(Boolean));
    assert.equal((await run(`SELECT * FROM "${table}"`)).length, 1, "cross-isolate conflict is harmless");
  }
  for (const [identifier, identifierValidator] of [
    ["relative/mcp", undefined], ["https://invalid.example/mcp#fragment", undefined],
    ["https://invalid.example/mcp", async () => false],
  ] as const) {
    const options: BetterAuthOptions = {
      baseURL: "https://resource.example/api/auth", secret: "resource-secret-0123456789-0123456789", database,
      plugins: [jwt({ disableSettingJwtHeader: true }), oauthProvider({ loginPage: "/login", consentPage: "/consent", resources: [identifier], identifierValidator,
        clientRegistrationDefaultResources: [identifier], allowDynamicClientRegistration: true, allowUnauthenticatedClientRegistration: true })],
    };
    const auth = betterAuth(options), { adapter } = await auth.$context;
    statements.length = 0;
    await assert.rejects(adapter.findOne({ model: "oauthResource", where: [{ field: "identifier", value: identifier }] }), { body: { code: "AUTH_CONFIGURATION_ERROR", message: "Configured OAuth resource identifier failed validation." } });
    assert.equal(statements.some(text => /^\s*(INSERT|UPDATE|DELETE)\b/i.test(text)), false);
    statements.length = 0;
    const response = await auth.handler(new Request("https://resource.example/api/auth/oauth2/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: "Fixture", redirect_uris: ["https://client.example/callback"] }) }));
    assert.equal(response.status, 500);
    assert.equal((await response.json() as { code: string }).code, "AUTH_CONFIGURATION_ERROR");
    assert.equal(statements.some(text => /^\s*(INSERT|UPDATE|DELETE)\b/i.test(text)), false);

  }
}
