import { describe, expect, it } from "vitest";
import {
  STAFF_ROLES,
  isStaffRole,
} from "../../src/spec/domain/model/ManifestGrammar.js";
import { meetsRole } from "../../src/spec/domain/service/StaffRoleHierarchy.js";

describe("STAFF_ROLES closed enum", () => {
  it("locks the v0.1 role vocabulary", () => {
    expect(STAFF_ROLES).toEqual(["owner", "editor", "contributor"]);
  });

  it("isStaffRole accepts members and rejects others", () => {
    expect(isStaffRole("owner")).toBe(true);
    expect(isStaffRole("editor")).toBe(true);
    expect(isStaffRole("contributor")).toBe(true);
    expect(isStaffRole("admin")).toBe(false);
    expect(isStaffRole("OWNER")).toBe(false);
    expect(isStaffRole("")).toBe(false);
  });
});

describe("meetsRole hierarchy", () => {
  it("owner satisfies every role", () => {
    expect(meetsRole("owner", "owner")).toBe(true);
    expect(meetsRole("owner", "editor")).toBe(true);
    expect(meetsRole("owner", "contributor")).toBe(true);
  });

  it("editor satisfies editor and contributor but not owner", () => {
    expect(meetsRole("editor", "owner")).toBe(false);
    expect(meetsRole("editor", "editor")).toBe(true);
    expect(meetsRole("editor", "contributor")).toBe(true);
  });

  it("contributor only satisfies contributor", () => {
    expect(meetsRole("contributor", "owner")).toBe(false);
    expect(meetsRole("contributor", "editor")).toBe(false);
    expect(meetsRole("contributor", "contributor")).toBe(true);
  });
});
