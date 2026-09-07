import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  safeReturnPath,
  signedOAuthQuery,
  SignInButton,
} from "../src/features/auth/auth-views";
import { signOut } from "../src/lib/auth";
import { resolveTheme } from "../src/app/preferences";

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
});
