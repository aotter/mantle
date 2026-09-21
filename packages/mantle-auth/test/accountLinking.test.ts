import { describe, expect, it, vi } from "vitest";
import type { DatabaseDriver } from "@aotter/mantle-runtime";

/**
 * `accountLinking` is a straight passthrough into Better Auth's
 * instance-level `account` option, so the regression worth pinning is
 * the wiring itself: an adopter that says nothing must not acquire an
 * `account` key, because Better Auth's own defaults (implicit linking
 * on, `requireLocalEmailVerified` on) are what every existing
 * deployment currently runs on. Observing the options Better Auth is
 * constructed with is the only seam — `MantleAuth` deliberately exposes
 * no handle on the underlying instance.
 */
const constructedWith: Array<Record<string, unknown>> = [];

vi.mock("better-auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("better-auth")>();
  return {
    ...actual,
    betterAuth: (options: Record<string, unknown>) => {
      constructedWith.push(options);
      return actual.betterAuth(options as Parameters<typeof actual.betterAuth>[0]);
    },
  };
});

const { createMantleAuth } = await import("../src/createMantleAuth.js");
type CreateMantleAuthOptions = Parameters<typeof createMantleAuth>[0];

function fakeBetterAuthDatabase(): CreateMantleAuthOptions["database"] {
  let id: unknown;
  const stmt = {
    bind: (...args: unknown[]) => { id = args[0]; return stmt; },
    first: async () => typeof id === "string" && id.startsWith("auth-schema:") ? { id } : null,
    all: async () => ({ results: [], success: true, meta: {} }),
  };
  return {
    prepare: () => stmt,
    exec: async () => ({ count: 0, duration: 0 }),
    batch: async () => [],
  } as unknown as CreateMantleAuthOptions["database"];
}

function fakeDriver(): DatabaseDriver {
  const stmt = {
    bind: () => stmt,
    first: async () => ({ id: "auth-schema:1" }),
    all: async () => [],
    run: async () => ({ success: true, meta: { changes: 0 } }),
  };
  return { prepare: () => stmt, batch: async () => [], migrations: { runAll: async () => undefined } };
}

function build(overrides: Partial<CreateMantleAuthOptions> = {}): Record<string, unknown> {
  constructedWith.length = 0;
  createMantleAuth({
    database: fakeBetterAuthDatabase(),
    driver: fakeDriver(),
    ipAddressHeaders: ["x-real-ip"],
    baseURL: "https://example.test",
    secret: "x".repeat(40),
    methods: [{ kind: "social", provider: "github", options: { clientId: "g", clientSecret: "g" } }],
    ...overrides,
  });
  expect(constructedWith).toHaveLength(1);
  return constructedWith[0]!;
}

describe("createMantleAuth accountLinking", () => {
  it("omits the account option entirely when the adopter does not configure linking", () => {
    // Not `toBeUndefined` — an explicit `account: undefined` would still
    // be a Mantle opinion about a key Better Auth owns.
    expect("account" in build()).toBe(false);
  });

  it("forwards the adopter's accountLinking unchanged", () => {
    const accountLinking = { enabled: true, trustedProviders: ["google", "github"] } as const;
    expect(build({ accountLinking }).account).toEqual({ accountLinking });
  });

  it("forwards a refusal of implicit linking", () => {
    const accountLinking = { disableImplicitLinking: true } as const;
    expect(build({ accountLinking }).account).toEqual({ accountLinking });
  });

  it("forwards a trustedProviders resolver without invoking it at construction", () => {
    const trustedProviders = vi.fn(async () => ["google"]);
    const options = build({ accountLinking: { trustedProviders } });
    expect((options.account as { accountLinking: { trustedProviders: unknown } }).accountLinking.trustedProviders)
      .toBe(trustedProviders);
    expect(trustedProviders).not.toHaveBeenCalled();
  });
});
