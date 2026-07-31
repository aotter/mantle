import { afterEach, describe, expect, it, vi } from "vitest";
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
