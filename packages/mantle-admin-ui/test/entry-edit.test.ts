import { describe, expect, it } from "vitest";
import { hasMissingRequired } from "../src/features/content/entry-edit-view";

describe("hasMissingRequired", () => {
  const schema = { required: ["title", "count", "enabled"] };

  it("rejects blank required values without rejecting zero or false", () => {
    expect(hasMissingRequired({ title: "", count: 0, enabled: false }, schema)).toBe(true);
    expect(hasMissingRequired({ title: "Ready", count: 0, enabled: false }, schema)).toBe(false);
  });
});
