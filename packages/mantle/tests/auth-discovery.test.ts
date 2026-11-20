/** OAuth discovery through the real Better Auth router: database round trips, response parity and limiter scope. */
import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { SQL } from "bun";
import type { BetterAuthOptions } from "better-auth/types";
import { betterAuth } from "better-auth/minimal";
import { emailOTP, jwt } from "better-auth/plugins";
import { mcp } from "@better-auth/mcp";
import { d1Adapter, postgresAdapter } from "../src/auth/adapter.js";
import { authLoader, type AuthInstance } from "../src/auth/caller.js";
import { authHardening } from "../src/auth/hardening.js";
import { authRoutes } from "../src/auth/routes.js";
import { authSchemaSql } from "../src/infrastructure/authSchema.js";
import { d1Shim } from "./apps/d1-shim.js";

type Run = (text: string, values?: unknown[]) => Promise<unknown>;
const origin = "http://localhost:3000";
/** Every discovery document the reference wiring serves, by the request path a client fetches. */
const discovery = [
  "/.well-known/oauth-protected-resource/mcp",
  "/.well-known/oauth-protected-resource",
  "/.well-known/oauth-authorization-server/api/auth",
  "/api/auth/.well-known/oauth-authorization-server",
  "/api/auth/.well-known/openid-configuration",
];

async function verifyDiscovery(
  database: BetterAuthOptions["database"],
  dialect: "sqlite" | "postgres",
  run: Run,
  statements: string[],
) {
  const options = (scopes: string[], rateLimit: BetterAuthOptions["rateLimit"]): BetterAuthOptions => ({
    baseURL: origin,
    basePath: "/api/auth",
    secret: "discovery-fixture-secret-0123456789-0123456789",
    database,
    plugins: [
      emailOTP({ sendVerificationOTP: async () => {} }),
      jwt({ disableSettingJwtHeader: true }),
      mcp({ loginPage: "/sign-in", consentPage: "/consent", resource: `${origin}/mcp`, scopes }),
    ],
    ...authHardening({ ipAddressHeaders: ["cf-connecting-ip"], baseURL: origin }),
    ...(rateLimit ? { rateLimit } : {}),
  });
  const hardened = options(["mcp", "offline_access"], undefined);
  for (const text of authSchemaSql(hardened, dialect)) await run(text);
  const serve = (opts: BetterAuthOptions) =>
    authRoutes(
      authLoader(async () => betterAuth(opts) as unknown as AuthInstance & { handler(r: Request): Promise<Response> }),
      { methods: [] },
    );
  // The limiter Mantle shipped before discovery was exempted: Better Auth's database storage on every path.
  const baseline = (scopes: string[]) => serve(options(scopes, { enabled: true, storage: "database" }));
  const routes = { mcp: serve(hardened), oidc: serve(options(["openid", "mcp", "offline_access"], undefined)) };
  const before = { mcp: baseline(["mcp", "offline_access"]), oidc: baseline(["openid", "mcp", "offline_access"]) };
  let client = 0;
  const request = (path: string, method = "GET", body?: unknown, ip = `203.0.113.${++client}`) =>
    new Request(origin + path, {
      method,
      headers: {
        "cf-connecting-ip": ip,
        ...(body ? { "content-type": "application/json", origin } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  const send = async (serve: (r: Request) => Promise<Response | null>, req: Request) => {
    statements.length = 0;
    const response = (await serve(req))!;
    const bytes = new Uint8Array(await response.arrayBuffer());
    return { response, bytes, trips: statements.length, statements: [...statements] };
  };
  const counts: Record<string, number> = {};
  for (const profile of ["mcp", "oidc"] as const)
    for (const path of discovery)
      for (const method of ["GET", "HEAD"])
        for (const pass of ["cold", "warm"]) {
          // Warm repeats the same client, so the limiter would find its row.
          const key = `${profile} ${method} ${path} ${pass}`,
            host = discovery.indexOf(path) * 4 + (method === "GET" ? 0 : 2) + (profile === "mcp" ? 0 : 40);
          const after = await send(routes[profile], request(path, method, undefined, `192.0.2.${host}`));
          const prior = await send(before[profile], request(path, method, undefined, `198.18.0.${host}`));
          counts[key] = after.trips;
          counts[`before ${key}`] = prior.trips;
          // Byte-identical to Better Auth's own response: status, every header and the body.
          expect([after.response.status, [...after.response.headers]]).toEqual([
            prior.response.status,
            [...prior.response.headers],
          ]);
          expect(after.bytes).toEqual(prior.bytes);
          expect(after.statements).toEqual([]);
        }
  // Served documents, as Better Auth answers them.
  const prm = await (await routes.mcp(request(discovery[0]!)))!.json();
  expect(prm).toMatchObject({ resource: `${origin}/mcp`, authorization_servers: [`${origin}/api/auth`] });
  expect((await routes.oidc(request("/api/auth/.well-known/openid-configuration")))!.status).toBe(200);
  expect((await routes.mcp(request("/api/auth/.well-known/openid-configuration")))!.status).toBe(404);
  // The root form shares the exempt limiter key but is not this issuer's document: a 404, still without database I/O.
  const root = await send(routes.mcp, request("/.well-known/oauth-authorization-server"));
  expect([root.response.status, root.trips]).toEqual([404, 0]);

  // Everything else stays limited: other methods, extended or trailing paths and neighbouring endpoints.
  await before.mcp(request("/api/auth/jwks")); // the first JWKS read creates the signing key
  for (const [method, path] of [
    ["POST", "/.well-known/oauth-protected-resource/mcp"],
    ["DELETE", "/.well-known/oauth-authorization-server/api/auth"],
    ["GET", "/.well-known/oauth-protected-resource/mcp/extra"],
    ["GET", "/.well-known/oauth-protected-resource/mcp/"],
    ["GET", "/api/auth/.well-known/oauth-authorization-server/extra"],
    ["GET", "/api/auth/get-session"],
    ["GET", "/api/auth/jwks"],
  ] as const) {
    const after = await send(routes.mcp, request(path, method));
    const prior = await send(before.mcp, request(path, method));
    expect([path, after.response.status, after.trips]).toEqual([path, prior.response.status, prior.trips]);
    expect(after.statements.some(text => /rateLimit/i.test(text))).toBe(true);
    counts[`limited ${method} ${path}`] = after.trips;
  }
  const statuses: number[] = [];
  for (let i = 0; i < 4; i++) {
    const body = { email: "a@example.com", type: "sign-in" };
    statuses.push(
      (await routes.mcp(request("/api/auth/email-otp/send-verification-otp", "POST", body, "198.51.100.1")))!.status,
    );
  }
  expect(statuses).toEqual([200, 200, 200, 429]);
  return counts;
}

function expectZero(counts: Record<string, number>) {
  for (const [key, trips] of Object.entries(counts)) {
    if (key.startsWith("before ")) expect([key, trips]).toEqual([key, 2]);
    else if (!key.startsWith("limited ")) expect([key, trips]).toEqual([key, 0]);
  }
}

test("OAuth discovery costs no database round trip and matches Better Auth's response on SQLite/D1", async () => {
  const db = new Database(":memory:"),
    statements: string[] = [],
    native = d1Shim(db);
  try {
    expectZero(
      await verifyDiscovery(
        d1Adapter({
          prepare: text => {
            statements.push(text);
            return native.prepare(text);
          },
        }),
        "sqlite",
        async (text, values = []) => db.query(text).all(...(values as never[])),
        statements,
      ),
    );
  } finally {
    db.close();
  }
}, 30000);

const url = process.env.MANTLE_NEXT_BUN_PG_URL;
(url ? test : test.skip)(
  "OAuth discovery costs no database round trip and matches Better Auth's response on PostgreSQL",
  async () => {
    const schema = `discovery_${crypto.randomUUID().replaceAll("-", "")}`,
      admin = new SQL(url!),
      statements: string[] = [];
    await admin.unsafe(`CREATE SCHEMA "${schema}"`);
    const sql = new SQL(url!, { connection: { search_path: schema }, max: 1 });
    try {
      expectZero(
        await verifyDiscovery(
          postgresAdapter({
            unsafe: (text: string, values: unknown[]) => {
              statements.push(text);
              return sql.unsafe(text, values);
            },
            begin: sql.begin.bind(sql),
          } as never),
          "postgres",
          async (text, values = []) => sql.unsafe(text, values),
          statements,
        ),
      );
    } finally {
      await sql.close();
      await admin.unsafe(`DROP SCHEMA "${schema}" CASCADE`);
      await admin.close();
    }
  },
  30000,
);
