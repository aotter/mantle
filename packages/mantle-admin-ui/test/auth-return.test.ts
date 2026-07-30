import { describe, expect, it } from "vitest";
import { resolveSignInReturnPath } from "../src/features/auth/auth-views";

describe("resolveSignInReturnPath", () => {
  it("preserves explicit and signed OAuth continuations only", () => {
    expect(resolveSignInReturnPath("?return=%2Fadmin%2Fsettings")).toBe("/admin/settings");
    expect(resolveSignInReturnPath("?return=https%3A%2F%2Fevil.test")).toBe("/admin");
    expect(resolveSignInReturnPath("?client_id=landing&sig=signed&state=state")).toBe(
      "/api/auth/oauth2/authorize?client_id=landing&sig=signed&state=state",
    );
    expect(resolveSignInReturnPath("?client_id=landing&state=unsigned")).toBe("/admin");
  });
});
