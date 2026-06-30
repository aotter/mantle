import { describe, expect, it } from "vitest";
import { CANONICAL_MIGRATIONS } from "../src/infrastructure/boot/canonicalMigrations.js";

function migrationSql(id: string): string {
  const migration = CANONICAL_MIGRATIONS.find((m) => m.id === id);
  if (!migration) throw new Error(`missing migration ${id}`);
  return migration.sql;
}

describe("CANONICAL_MIGRATIONS", () => {
  it("keeps Better Auth OAuth provider table takeover as a forward migration", () => {
    const init = migrationSql("0001-init");
    expect(init).not.toMatch(/CREATE TABLE IF NOT EXISTS oauthApplication\b/);
    expect(init).not.toMatch(/CREATE TABLE IF NOT EXISTS oauthAccessToken\b/);
    expect(init).not.toMatch(/CREATE TABLE IF NOT EXISTS oauthConsent\b/);

    const oauth = migrationSql("0003-better-auth-oauth-provider");
    for (const table of [
      "oauthAccessToken",
      "oauthConsent",
      "oauthApplication",
      "oauthRefreshToken",
      "oauthClient",
    ]) {
      expect(oauth).toContain(`DROP TABLE IF EXISTS ${table};`);
    }

    expect(oauth).toMatch(
      /CREATE TABLE IF NOT EXISTS oauthAccessToken\s*\([\s\S]*\btoken\s+TEXT NOT NULL UNIQUE/,
    );
    expect(oauth).toMatch(
      /CREATE TABLE IF NOT EXISTS oauthRefreshToken\s*\([\s\S]*\btoken\s+TEXT NOT NULL UNIQUE/,
    );
    expect(oauth).toMatch(
      /CREATE TABLE IF NOT EXISTS oauthConsent\s*\([\s\S]*\breferenceId\s+TEXT/,
    );
    expect(oauth).not.toMatch(/\baccessToken\s+TEXT/);
    expect(oauth).not.toMatch(/\brefreshToken\s+TEXT/);
    expect(oauth).not.toMatch(/\bconsentGiven\b/);
  });
});
