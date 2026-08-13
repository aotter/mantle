import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { safeReturnPath, SignInButton } from "../src/features/auth/auth-views";
import { signOut } from "../src/lib/auth";

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
  it("keeps return navigation on the same origin", () => {
    expect(safeReturnPath("/admin/c/stories?draft=1#edit")).toBe(
      "/admin/c/stories?draft=1#edit",
    );
    expect(safeReturnPath("//evil.test/admin")).toBe("/admin");
    expect(safeReturnPath("/\\evil.test/admin")).toBe("/admin");
    expect(safeReturnPath("https://evil.test/admin")).toBe("/admin");
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
