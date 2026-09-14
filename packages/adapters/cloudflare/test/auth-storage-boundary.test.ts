import { expect, test, vi } from "vitest";
import { SqliteMantleStorageAdapter } from "@aotter/mantle-runtime";
import { createMantleWorker } from "../src/worker/createMantleWorker.js";
import { createAuth, type CreateAuthConfig } from "../src/auth/createAuth.js";
import { D1DatabaseDriver } from "../src/bindings/D1DatabaseDriver.js";
import { compileTestPlan } from "./compileTestPlan.js";
import { sqliteD1 } from "./fakes/sqlite-d1.js";

const origin = "https://site.example.test";
const config = (database: D1Database): CreateAuthConfig => ({
  database, baseURL: origin, secret: "x".repeat(40),
  methods: [{ kind: "email-otp", sender: { send: async () => {} } }],
});

test.each([false, true])("Auth cold boot remains usable with separate content storage: %s", async (separate) => {
  const authDatabase = sqliteD1();
  const contentDatabase = sqliteD1();
  const pending: Promise<unknown>[] = [];
  try {
    const worker = createMantleWorker({
      plan: compileTestPlan([]),
      auth: () => createAuth(config(authDatabase.db)),
      bindings: (_env, conventional) => separate ? { ...conventional,
        storage: new SqliteMantleStorageAdapter(new D1DatabaseDriver(contentDatabase.db)),
      } : conventional,
    });
    const response = await worker.fetch(new Request(`${origin}/api/auth/sign-in/email-otp`, {
      method: "POST", headers: { origin, "content-type": "application/json" },
      body: JSON.stringify({ email: "test@example.test", otp: "123456" }),
    }), { DB: authDatabase.db }, { waitUntil: (promise: Promise<unknown>) => pending.push(promise) } as unknown as ExecutionContext);
    await Promise.all(pending);
    expect(response.status).toBe(400); // Invalid OTP, never a missing Auth table.
    if (separate) expect(authDatabase.sqlite.prepare("SELECT name FROM sqlite_master WHERE name='entries'").get()).toBeUndefined();
  } finally { authDatabase.sqlite.close(); contentDatabase.sqlite.close(); }
});

test("Auth prepares lazily, retries failures, coalesces callers and preserves data across new contexts and plugin schemas", async () => {
  const { db, sqlite } = sqliteD1();
  try {
    const auth = createAuth(config(db));
    await auth.ready;
    expect(sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()).toEqual([]);
    const batch = vi.spyOn(db, "batch").mockRejectedValueOnce(new Error("temporary D1 failure"));
    await expect(auth.listUsers()).rejects.toThrow("temporary D1 failure");
    expect(await Promise.all([auth.getUserRole("missing"), auth.getUserRole("missing")])).toEqual([null, null]);
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM _migrations WHERE id LIKE 'auth-schema:%'").get()!.count).toBe(1);
    const preparedBatches = batch.mock.calls.length;
    const invited = await auth.inviteUser("Owner@Example.test", "owner");
    expect(invited.kind).toBe("created");
    expect(await createAuth(config(db)).getUserRole(invited.id)).toBe("owner");
    expect(batch).toHaveBeenCalledTimes(preparedBatches); // Persisted ledger avoids introspection/DDL.
    const oauth = createAuth({ ...config(db), oauthProvider: {
      loginPage: "/admin/sign-in", consentPage: "/oauth/consent", scopes: ["mcp"], mcpResource: `${origin}/mcp`,
    } });
    expect(await oauth.listOAuthConsents!(invited.id)).toEqual([]);
    expect(await oauth.getUserRole(invited.id)).toBe("owner");
    expect(await oauth.revokeOAuthConsent!(invited.id, "missing")).toBe(false);
    expect(sqlite.prepare("SELECT name FROM sqlite_master WHERE name='entries'").get()).toBeUndefined();
    expect(sqlite.prepare("SELECT name FROM sqlite_master WHERE name='oauthConsent'").get()).toBeDefined();
  } finally { sqlite.close(); }
});
