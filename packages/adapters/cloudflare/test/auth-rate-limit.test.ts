import { afterEach, expect, it, vi } from "vitest";
import { CANONICAL_MIGRATIONS } from "@aotter/mantle-runtime";
import { createConventionalAuth } from "../src/auth/conventionalAuth.js";
import { sqliteD1 } from "./fakes/sqlite-d1.js";

afterEach(() => vi.unstubAllEnvs());

it("limits anonymous DCR without NODE_ENV and keys only by Cloudflare's client IP", async () => {
  vi.stubEnv("NODE_ENV", "");
  const { db, sqlite } = sqliteD1();
  for (const migration of CANONICAL_MIGRATIONS) sqlite.exec(migration.sql);
  try {
    const auth = createConventionalAuth({
      DB: db, PUBLIC_ORIGIN: "https://rate-limit.test",
      MANTLE_AUTH_MODE: "self-managed",
      BETTER_AUTH_SECRET: crypto.randomUUID() + crypto.randomUUID(),
      ADMIN_GITHUB_LOGIN: "owner", GITHUB_CLIENT_ID: "fixture", GITHUB_CLIENT_SECRET: "fixture",
    });
    await auth.ready;
    const register = (ip: string, index: number) => auth.handler(new Request("https://rate-limit.test/api/auth/oauth2/register", {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": ip, "x-forwarded-for": `198.51.100.${index}` },
      body: JSON.stringify({
        client_name: "test", redirect_uris: ["https://client.test/callback"],
        token_endpoint_auth_method: "none", grant_types: ["authorization_code"], response_types: ["code"], scope: "mcp",
      }),
    }));
    for (let i = 1; i <= 5; i++) expect((await register("203.0.113.41", i)).status).toBe(201);
    const limited = await register("203.0.113.41", 6);
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("x-retry-after"))).toBeGreaterThan(0);
    expect((await register("203.0.113.42", 6)).status).toBe(201);
    expect(sqlite.prepare("SELECT count(*) AS n FROM oauthClient").get()?.n).toBe(6);
  } finally { sqlite.close(); }
});
