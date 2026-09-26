import { describe, expect, it } from "vitest";
import * as moved from "@aotter/mantle-ui/kit";
import * as compat from "../src/kit";

describe("@aotter/mantle-admin-ui/kit (compatibility re-export, ADR-0029)", () => {
  it("exports exactly the components of @aotter/mantle-ui/kit", () => {
    expect(Object.keys(compat).sort()).toEqual(Object.keys(moved).sort());
    for (const name of Object.keys(moved)) {
      expect(compat[name as keyof typeof compat]).toBe(moved[name as keyof typeof moved]);
    }
    expect(Object.keys(moved)).toEqual(expect.arrayContaining(["AuthCard", "Button", "Dialog", "SignInButton"]));
  });
});
