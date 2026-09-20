import { DiagnosticError, runtimeDiagnostic } from "@aotter/mantle-spec";
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


test("selected Auth preserves a recognized storage failure without retrying a mutation", async () => {
  const { db, sqlite } = sqliteD1();
  try {
    const auth = createAuth(config(db));
    await auth.listUsers();
    const failure = new DiagnosticError(runtimeDiagnostic({
      code: "OUTCOME_UNKNOWN", severity: "error", path: "adapter/auth/storage",
      message: "The operation outcome must be checked before retrying.",
      failure: { outcome: "unknown", retry: "reconcile", resource: "auth" },
    }), { cause: new Error("private SQL/provider detail") });
    const prepare = vi.spyOn(db, "prepare").mockImplementation(() => { throw failure; });
    await expect(auth.setUserRole("existing-user", "owner")).rejects.toBe(failure);
    expect(prepare).toHaveBeenCalledTimes(1);
  } finally { sqlite.close(); }
});


test("Auth email unknown outcome is observed without resending or leaking provider details", async () => {
  const { db, sqlite } = sqliteD1();
  const failure = new DiagnosticError(runtimeDiagnostic({
    code: "OUTCOME_UNKNOWN", severity: "error", path: "email",
    message: "Delivery acknowledgement unavailable.",
    failure: { outcome: "unknown", retry: "reconcile", resource: "email" },
  }), { cause: new Error("private-email-provider-detail") });
  const send = vi.fn().mockRejectedValue(failure);
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const auth = createAuth({ ...config(db), methods: [{ kind: "email-otp", sender: { send } }] });
    const response = await auth.handler(new Request(`${origin}/api/auth/email-otp/send-verification-otp`, {
      method: "POST", headers: { origin, "content-type": "application/json" },
      body: JSON.stringify({ email: "test@example.test", type: "sign-in" }),
    }));
    await vi.waitFor(() => expect(log).toHaveBeenCalledWith(expect.stringContaining("background task"), failure));
    expect(send).toHaveBeenCalledTimes(1);
    expect(response.status).toBe(200); // Anonymous email acceptance avoids account-existence leakage.
    expect(await response.text()).not.toContain("private-email-provider-detail");
  } finally { log.mockRestore(); sqlite.close(); }
});

test("Auth hashes email sign-in secrets at rest", async () => {
  const { db, sqlite } = sqliteD1();
  let otp = "";
  let magicLink = "";
  const email = "hashed@example.test";
  try {
    const auth = createAuth({
      ...config(db),
      methods: [
        { kind: "email-otp", sender: { send: async ({ subject }) => {
          otp = subject.match(/\d{6}/u)?.[0] ?? "";
        } } },
        { kind: "magic-link", sender: { send: async ({ text }) => {
          magicLink = text.match(/^https:\/\/\S+$/mu)?.[0] ?? "";
        } } },
      ],
    });

    expect((await auth.handler(new Request(`${origin}/api/auth/email-otp/send-verification-otp`, {
      method: "POST", headers: { origin, "content-type": "application/json" },
      body: JSON.stringify({ email, type: "sign-in" }),
    }))).status).toBe(200);
    const otpValue = sqlite.prepare("SELECT value FROM verification").get()!.value as string;
    expect(otp).toMatch(/^\d{6}$/u);
    expect(otpValue).not.toContain(otp);
    expect((await auth.handler(new Request(`${origin}/api/auth/sign-in/email-otp`, {
      method: "POST", headers: { origin, "content-type": "application/json" },
      body: JSON.stringify({ email, otp }),
    }))).status).toBe(200);

    expect((await auth.handler(new Request(`${origin}/api/auth/sign-in/magic-link`, {
      method: "POST", headers: { origin, "content-type": "application/json" },
      body: JSON.stringify({ email }),
    }))).status).toBe(200);
    const token = new URL(magicLink).searchParams.get("token");
    const magicIdentifier = sqlite.prepare("SELECT identifier FROM verification").get()!.identifier as string;
    expect(token).toBeTruthy();
    expect(magicIdentifier).not.toBe(token);
    expect((await auth.handler(new Request(magicLink, { headers: { origin } }))).status).toBe(302);
  } finally { sqlite.close(); }
});

test("Auth honors explicit native Better Auth storage overrides", async () => {
  const { db, sqlite } = sqliteD1();
  let otp = "";
  let magicLink = "";
  const email = "plain@example.test";
  try {
    const auth = createAuth({
      ...config(db),
      methods: [
        {
          kind: "email-otp",
          sender: { send: async ({ subject }) => { otp = subject.match(/\d{6}/u)?.[0] ?? ""; } },
          options: { storeOTP: "plain" },
        },
        {
          kind: "magic-link",
          sender: { send: async ({ text }) => { magicLink = text.match(/^https:\/\/\S+$/mu)?.[0] ?? ""; } },
          options: { storeToken: "plain" },
        },
      ],
    });

    await auth.handler(new Request(`${origin}/api/auth/email-otp/send-verification-otp`, {
      method: "POST", headers: { origin, "content-type": "application/json", "cf-connecting-ip": "192.0.2.20" },
      body: JSON.stringify({ email, type: "sign-in" }),
    }));
    expect(sqlite.prepare("SELECT value FROM verification").get()!.value).toContain(otp);
    expect((await auth.handler(new Request(`${origin}/api/auth/sign-in/email-otp`, {
      method: "POST", headers: { origin, "content-type": "application/json", "cf-connecting-ip": "192.0.2.21" },
      body: JSON.stringify({ email, otp }),
    }))).status).toBe(200);

    await auth.handler(new Request(`${origin}/api/auth/sign-in/magic-link`, {
      method: "POST", headers: { origin, "content-type": "application/json", "cf-connecting-ip": "192.0.2.22" },
      body: JSON.stringify({ email }),
    }));
    const token = new URL(magicLink).searchParams.get("token");
    expect(sqlite.prepare("SELECT identifier FROM verification WHERE identifier NOT LIKE 'sign-in-otp-%'").get()!.identifier).toBe(token);
  } finally { sqlite.close(); }
});
