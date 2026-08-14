import { describe, expect, it } from "vitest";
import {
  editorHiddenFields,
  hasMissingRequired,
  stringFieldWidget,
} from "../src/features/content/entry-edit-view";

describe("hasMissingRequired", () => {
  const schema = { required: ["title", "count", "enabled"] };

  it("rejects blank required values without rejecting zero or false", () => {
    expect(hasMissingRequired({ title: "", count: 0, enabled: false }, schema)).toBe(true);
    expect(hasMissingRequired({ title: "Ready", count: 0, enabled: false }, schema)).toBe(false);
  });
});

describe("editorHiddenFields", () => {
  it("hides locale and whichever parent join field the manifest declares", () => {
    expect(editorHiddenFields({ localized: true, translates: { parent: "stories", on: "storyKey" } }))
      .toEqual(["locale", "storyKey"]);
  });
});

describe("stringFieldWidget", () => {
  it("uses only explicit UI and content-format declarations", () => {
    expect(stringFieldWidget({ type: "string", maxLength: 500 }, null)).toBe("input");
    expect(stringFieldWidget({ type: "string" }, "textarea")).toBe("textarea");
    expect(stringFieldWidget({ type: "string", "x-mcp-hint": "markdown" }, null)).toBe("richtext");
  });
});
