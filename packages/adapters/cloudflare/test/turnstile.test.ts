import { describe, expect, it } from "vitest";
import {
  InvokeFailure,
  type HandlerContext,
  type HandlerFn,
} from "@aotter/mantle-runtime";
import { cloudflareTurnstileCheck } from "../src/handlers/turnstile.js";

const guest = {
  user: null,
  staff: null,
  env: {},
} satisfies HandlerContext<Record<string, never>>;

describe("cloudflareTurnstileCheck", () => {
  it("fits a generated object input and typed Worker environment", async () => {
    type FormInput = { readonly "cf-turnstile-response"?: string };
    type SiteEnv = { readonly DB: D1Database };
    const check: HandlerFn<FormInput, { ok: true }, SiteEnv> = cloudflareTurnstileCheck({
      secret: "dev-stub",
      tokenField: "cf-turnstile-response",
    });
    await expect(check(
      { "cf-turnstile-response": "pass" },
      { user: null, staff: null, env: { DB: {} as D1Database } },
    )).resolves.toEqual({ ok: true });
  });

  it("keeps the optional guard disabled without a secret", async () => {
    await expect(cloudflareTurnstileCheck({})({}, guest)).resolves.toEqual({ ok: true });
  });

  it("bypasses authenticated callers before requiring a token", async () => {
    const authenticated = { ...guest, user: { id: "user-1" } };
    await expect(
      cloudflareTurnstileCheck({ secret: "production-secret" })({}, authenticated),
    ).resolves.toEqual({ ok: true });
  });

  it("supports the widget field and deterministic dev-stub behavior", async () => {
    const check = cloudflareTurnstileCheck({
      secret: "dev-stub",
      tokenField: "cf-turnstile-response",
    });

    await expect(check({ "cf-turnstile-response": "pass" }, guest)).resolves.toEqual({ ok: true });
    await expect(check({ "cf-turnstile-response": "fail" }, guest)).rejects.toMatchObject({
      diagnostic: { code: "AUTH_DENIED" },
    });
    await expect(check({}, guest)).rejects.toBeInstanceOf(InvokeFailure);
  });
});
