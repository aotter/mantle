import { describe, expect, it } from "vitest";
import { CANONICAL_MIGRATIONS } from "../src/infrastructure/boot/canonicalMigrations.js";

function migrationSql(id: string): string {
  const migration = CANONICAL_MIGRATIONS.find((m) => m.id === id);
  if (!migration) throw new Error(`missing migration ${id}`);
  return migration.sql;
}

function tableSql(sql: string, table: string): string {
  const match = sql.match(
    new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\s*\\([\\s\\S]*?\\n\\s*\\);`),
  );
  if (!match) throw new Error(`missing table ${table}`);
  return match[0];
}

describe("CANONICAL_MIGRATIONS", () => {
  it("does not provision unused editorial tables", () => {
    const init = migrationSql("0001-init");
    expect(init).not.toMatch(/CREATE TABLE IF NOT EXISTS (approvals|revisions)\b/);
  });

  it("keeps Better Auth OAuth provider tables in the canonical init schema", () => {
    const init = migrationSql("0001-init");
    expect(init).not.toMatch(/CREATE TABLE IF NOT EXISTS oauthApplication\b/);
    expect(CANONICAL_MIGRATIONS.map((migration) => migration.id)).not.toContain(
      "0003-better-auth-oauth-provider",
    );

    for (const table of [
      "jwks",
      "oauthClient",
      "oauthResource",
      "oauthClientResource",
      "oauthRefreshToken",
      "oauthAccessToken",
      "oauthConsent",
      "oauthClientAssertion",
    ]) {
      expect(init).toContain(`CREATE TABLE IF NOT EXISTS ${table}`);
    }

    const jwks = tableSql(init, "jwks");
    const account = tableSql(init, "account");
    const client = tableSql(init, "oauthClient");
    const accessToken = tableSql(init, "oauthAccessToken");
    const refreshToken = tableSql(init, "oauthRefreshToken");
    const consent = tableSql(init, "oauthConsent");

    expect(jwks).toMatch(
      /CREATE TABLE IF NOT EXISTS jwks\s*\([\s\S]*\bprivateKey\s+TEXT NOT NULL/,
    );
    expect(account).toMatch(/\bissuer\s+TEXT NOT NULL/);
    expect(account).toMatch(/UNIQUE \(issuer, accountId\)/);
    expect(client).toMatch(/\bclientDiscoveryId\s+TEXT/);
    expect(client).toMatch(/\bapplicationType\s+TEXT/);
    expect(client).not.toMatch(/\b(public|type)\s+(INTEGER|TEXT)/);
    expect(accessToken).toMatch(
      /CREATE TABLE IF NOT EXISTS oauthAccessToken\s*\([\s\S]*\btoken\s+TEXT NOT NULL UNIQUE/,
    );
    expect(refreshToken).toMatch(
      /CREATE TABLE IF NOT EXISTS oauthRefreshToken\s*\([\s\S]*\btoken\s+TEXT NOT NULL UNIQUE/,
    );
    expect(consent).toMatch(
      /CREATE TABLE IF NOT EXISTS oauthConsent\s*\([\s\S]*\breferenceId\s+TEXT/,
    );
    expect(accessToken).not.toMatch(/\baccessToken\s+TEXT/);
    expect(refreshToken).not.toMatch(/\brefreshToken\s+TEXT/);
    expect(consent).not.toMatch(/\bconsentGiven\b/);
  });
});
