import { describe, expect, it } from "vitest";
import {
  canEditEntry,
  editorHiddenFields,
  entryTitle,
  hasMissingRequired,
  stringFieldWidget,
} from "../src/features/content/entry-edit-view";

describe("canEditEntry", () => {
  const access = (overrides: Partial<Parameters<typeof canEditEntry>[0]> = {}) => canEditEntry({
    role: "owner",
    isReadOnly: false,
    isOperational: true,
    isDraft: false,
    operationalEditUnlocked: false,
    ...overrides,
  });

  it("requires an owner or editor to explicitly unlock operational records", () => {
    expect(access()).toBe(false);
    expect(access({ operationalEditUnlocked: true })).toBe(true);
    expect(access({ role: "contributor", operationalEditUnlocked: true })).toBe(false);
    expect(access({ isReadOnly: true, operationalEditUnlocked: true })).toBe(false);
  });

  it("keeps publishing collection permissions unchanged", () => {
    expect(access({ isOperational: false })).toBe(true);
    expect(access({ role: "contributor", isOperational: false, isDraft: true })).toBe(true);
  });
});

describe("entryTitle", () => {
  it("uses the explicit operational list primary field", () => {
    const collection = {
      lifecycle: "operational" as const,
      list: { primaryField: "orderNumber", columns: [] },
      schema: {
        type: "object",
        required: ["orderToken", "orderNumber"],
        properties: { orderToken: { type: "string" }, orderNumber: { type: "string" } },
      },
    };
    expect(entryTitle(
      { orderToken: "internal-token", orderNumber: "MNT-20260814-0001" },
      "Untitled",
      collection,
      "entry-id",
    )).toBe("MNT-20260814-0001");
    expect(entryTitle({ orderToken: "internal-token" }, "Untitled", collection, "entry-id"))
      .toBe("entry-id");
  });
});

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
