import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AdminApp } from "../src/app/admin-app";
import { AdminRouterProvider } from "../src/app/router";
import { ApiError } from "../src/lib/api";
import {
  safeReturnPath,
  signedOAuthQuery,
  SignInButton,
  claimInFlight,
} from "../src/features/auth/auth-views";
import { SignInFlow, SIGN_IN_FLOW_INITIAL, signInFlowReducer } from "../src/kit";
import { OneTimeCodeInput } from "../src/components/one-time-code-input";
import { signOut } from "../src/lib/auth";
import { PreferencesProvider, resolveTheme } from "../src/app/preferences";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("signOut", () => {
  it("uses the mounted auth route before returning to sign-in", async () => {
    const fetch = vi.fn(async () => ({}));
    const location = { href: "" };
    vi.stubGlobal("fetch", fetch);
    vi.stubGlobal("window", { location });

    signOut();
    await Promise.resolve();

    expect(fetch).toHaveBeenCalledWith("/api/auth/sign-out", {
      method: "POST",
      credentials: "include",
    });
    expect(location.href).toBe("/admin/sign-in");
  });
});

describe("sign-in", () => {
  it("renders no Admin UI in an iframe, including direct static asset URLs", () => {
    for (const pathname of ["/_mantle/admin/index.html", "/admin", "/admin/sign-in", "/oauth/consent"]) {
      vi.stubGlobal("window", { self: {}, top: {}, location: { pathname, search: "" } });
      expect(renderToStaticMarkup(createElement(AdminRouterProvider, null, createElement(AdminApp)))).toBe("");
    }
  });

  it("lets members disconnect their own apps without granting staff access", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, retryOnMount: false } } });
    await client.fetchQuery({
      queryKey: ["me"],
      queryFn: () => Promise.reject(new ApiError("forbidden", 403, {})),
    }).catch(() => undefined);
    client.setQueryData(["oauth-consents"], [{ id: "grant-1", clientId: "client-1", clientName: "My agent", scopes: ["mcp"] }]);
    const render = (pathname: string) => {
      vi.stubGlobal("window", { location: { pathname, search: "" } });
      return renderToStaticMarkup(createElement(QueryClientProvider, { client },
        createElement(PreferencesProvider, null,
          createElement(AdminRouterProvider, null, createElement(AdminApp))),
      ));
    };
    expect(render("/admin/connected-apps")).toContain("My agent");
    expect(render("/admin/connected-apps")).toContain('action="/oauth/consents/revoke"');
    expect(render("/admin/settings")).not.toContain("My agent");
    expect(render("/admin/settings")).toContain('href="/admin/connected-apps"');
    client.clear();
  });

  it("uses the system theme until an explicit override exists", () => {
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
    expect(resolveTheme("light", true)).toBe("light");
    expect(resolveTheme("dark", false)).toBe("dark");
  });

  it("keeps return navigation on the same origin", () => {
    expect(safeReturnPath("/admin/c/stories?draft=1#edit")).toBe(
      "/admin/c/stories?draft=1#edit",
    );
    expect(safeReturnPath("//evil.test/admin")).toBe("/admin");
    expect(safeReturnPath("/\\evil.test/admin")).toBe("/admin");
    expect(safeReturnPath("https://evil.test/admin")).toBe("/admin");
  });

  it("forwards only fields covered by Better Auth's signed OAuth query", () => {
    const search = new URLSearchParams([
      ["client_id", "https://client.test/metadata.json"],
      ["scope", "mcp"],
      ["sig", "signed"],
      ["ba_param", "client_id"],
      ["ba_param", "scope"],
      ["ba_param", "ba_param"],
      ["return", "/admin"],
    ]).toString();

    expect(signedOAuthQuery(`?${search}`)).toBe(
      "client_id=https%3A%2F%2Fclient.test%2Fmetadata.json&scope=mcp&sig=signed&ba_param=client_id&ba_param=scope&ba_param=ba_param",
    );
    expect(signedOAuthQuery("?return=%2Fadmin")).toBeUndefined();
  });

  it("disables a pending sign-in action and shows its indicator", () => {
    const html = renderToStaticMarkup(
      createElement(SignInButton, { busy: true }, "Continue with GitHub"),
    );

    expect(html).toContain("disabled");
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain("animate-spin");
    expect(html).toContain("Continue with GitHub");
  });

  it("offers the two-step email-OTP flow through the kit, code screen not yet shown", () => {
    const html = renderToStaticMarkup(
      createElement(SignInFlow, {
        labels: {
          description: "Sign in with a one-time code.",
          emailLabel: "Email address",
          emailPlaceholder: "you@example.com",
          sendButton: "Send code",
          sentTo: (email: string) => `We sent a code to ${email}.`,
          otpLabel: "One-time code",
          verifyButton: "Verify and sign in",
          useAnotherEmail: "Use a different email",
          requestFailed: "Something went wrong.",
        },
        onSendCode: () => Promise.resolve(),
        onVerifyCode: () => Promise.resolve(),
      }),
    );

    expect(html).toContain('id="signin-email"');
    expect(html).toContain("Send code");
    expect(html).not.toContain('autocomplete="one-time-code"');
  });

  it("rejects a second OTP verify in the same tick before busy state updates", () => {
    const lock = { current: false };
    expect(claimInFlight(lock)).toBe(true);
    expect(claimInFlight(lock)).toBe(false);
    lock.current = false;
    expect(claimInFlight(lock)).toBe(true);
  });
});

describe("SignInFlow step machine", () => {
  const start = { ...SIGN_IN_FLOW_INITIAL, email: "me@example.com" };

  it("advances to the code screen only after a successful send", () => {
    const busy = signInFlowReducer(start, { type: "start" });
    expect(busy).toMatchObject({ busy: true, error: null, step: "email" });
    expect(signInFlowReducer(busy, { type: "sent", error: "nope" })).toMatchObject({ busy: false, error: "nope", step: "email" });
    expect(signInFlowReducer(busy, { type: "sent" })).toMatchObject({ busy: false, error: null, step: "otp" });
  });

  it("keeps the form locked after a successful verify so the consumed code is not resubmitted", () => {
    const verifying = signInFlowReducer({ ...start, step: "otp", otp: "123456" }, { type: "start" });
    expect(signInFlowReducer(verifying, { type: "verified" })).toMatchObject({ busy: true, step: "otp" });
    expect(signInFlowReducer(verifying, { type: "verified", error: "wrong code" })).toMatchObject({ busy: false, error: "wrong code", step: "otp" });
    expect(signInFlowReducer(verifying, { type: "failed", error: "offline" })).toMatchObject({ busy: false, error: "offline" });
  });

  it("clears the code and any error when going back to the email screen", () => {
    const errored = { ...start, step: "otp" as const, otp: "123456", error: "wrong code" };
    expect(signInFlowReducer(errored, { type: "back" })).toEqual({ ...start, step: "email", otp: "", error: null, busy: false });
  });

  it("labels the code input for screen readers with the host's copy", () => {
    const html = renderToStaticMarkup(
      createElement(OneTimeCodeInput, { "aria-label": "驗證碼", value: "", onChange: () => undefined }),
    );
    expect(html).toContain('aria-label="驗證碼"');
    expect(html).not.toContain('aria-label="One-time code"');
  });
});
