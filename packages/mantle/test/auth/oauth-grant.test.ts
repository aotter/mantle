import { expect, it } from "vitest";
import { sqlite } from "./sqliteFixture.js";
import { assertActiveUserGrant, verifyOAuthJwt } from "../../src/auth/oauthTokens.js";

it("the native live grant JOIN returns each fresh role, and rejects a revoked/expired/deleted grant", async () => {
  const { driver } = sqlite();
  await driver.batch([
    { sql: 'CREATE TABLE "user" (id TEXT PRIMARY KEY, role TEXT)' },
    { sql: 'CREATE TABLE session (id TEXT PRIMARY KEY, "userId" TEXT, "expiresAt" TEXT)' },
    { sql: 'CREATE TABLE "oauthConsent" (id TEXT PRIMARY KEY, "userId" TEXT, "clientId" TEXT, scopes TEXT, resources TEXT)' },
    { sql: `INSERT INTO "user" VALUES ('u', 'owner')` },
    { sql: `INSERT INTO session VALUES ('s', 'u', '2999-01-01T00:00:00.000Z')` },
    { sql: `INSERT INTO "oauthConsent" VALUES ('c', 'u', 'app', '["mcp"]', '["https://x/mcp"]')` },
  ]);
  const claims = { sub: "u", sid: "s", azp: "app", mantle_consent_id: "c", scope: "mcp", role: "owner" };
  const read = () => assertActiveUserGrant(driver, claims, "https://x/mcp");
  for (const role of ["owner", "contributor", "editor", null]) {
    await driver.batch([{ sql: 'UPDATE "user" SET role = ?', binds: [role] }]);
    expect(await read()).toBe(role);
  }
  await expect(assertActiveUserGrant(driver, claims, "https://other/mcp")).rejects.toThrow(/no longer active/);
  await expect(assertActiveUserGrant(driver, { ...claims, scope: "mcp admin" }, "https://x/mcp")).rejects.toThrow(/no longer active/);
  await expect(assertActiveUserGrant(driver, { ...claims, mantle_consent_id: "missing" }, "https://x/mcp")).rejects.toThrow(/no longer active/);
  await driver.batch([{ sql: `UPDATE session SET "expiresAt" = '2000-01-01T00:00:00.000Z'` }]);
  await expect(read()).rejects.toThrow(/no longer active/);
  await driver.batch([{ sql: `UPDATE session SET "expiresAt" = '2999-01-01T00:00:00.000Z'` }, { sql: 'DELETE FROM "user"' }]);
  await expect(read()).rejects.toThrow(/no longer active/);
});

it("only the verifier's live-grant result supplies a role; token claims cannot, and DPoP still fails closed", async () => {
  const claims = { sub: "u", azp: "app", role: "owner", currentRole: "owner", scope: "mcp" };
  const verify = async () => ({ claims });
  const fallback = await verifyOAuthJwt("a.b.c", { audience: "https://x/mcp" }, verify);
  expect(fallback).toEqual({ ok: true, userId: "u", clientId: "app", credentialId: null, scopes: ["mcp"] });
  expect(await verifyOAuthJwt("a.b.c", { audience: "https://x/mcp" }, async () => ({ claims, currentRole: null }))).toMatchObject({ ok: true, currentRole: null });
  expect(await verifyOAuthJwt("a.b.c", { audience: "https://x/mcp" }, async () => ({ claims: { ...claims, cnf: { jkt: "bound-key" } }, currentRole: "editor" }))).toMatchObject({ ok: false, reason: "invalid-dpop-proof" });
});
