import { describe, expect, it } from "vitest";
import { collectionSummaryKey } from "../src/features/content/collection-view";
import { contentLocales, splitLocaleChips } from "../src/features/content/locale-badge";
import type { Collection } from "../src/lib/types";
import { canEditEntry, editorHiddenFields, entryTitle, hasMissingRequired, stringFieldWidget } from "../src/features/content/entry-edit-view";
import { readViewParams } from "../src/features/ops/view-page";
function collection(overrides: Partial<Collection>): Collection {
  return {
    name: "widgets",
    exportFields: [],
    title: "Widgets",
    description: null,
    lifecycle: "publishing",
    hasTranslations: false,
    localized: false,
    ...overrides,
  };
}

describe("collectionSummaryKey", () => {
  it("picks the lifecycle+i18n variant when both capabilities are present", () => {
    expect(collectionSummaryKey(collection({ lifecycle: "publishing", hasTranslations: true }))).toBe(
      "collection.schemaSummary.lifecycleAndI18n",
    );
  });

  it("picks the lifecycle-only variant when there's a publish workflow but no translations", () => {
    expect(collectionSummaryKey(collection({ lifecycle: "publishing", hasTranslations: false }))).toBe(
      "collection.schemaSummary.lifecycleOnly",
    );
  });

  it("treats direct localized rows as i18n content", () => {
    expect(collectionSummaryKey(collection({ localized: true }))).toBe(
      "collection.schemaSummary.lifecycleAndI18n",
    );
  });

  it("picks the i18n-only variant for lifecycle: operational collections that still have translations", () => {
    expect(collectionSummaryKey(collection({ lifecycle: "operational", hasTranslations: true }))).toBe(
      "collection.schemaSummary.i18nOnly",
    );
  });

  it("picks the plain variant for lifecycle: operational collections with no translations", () => {
    expect(collectionSummaryKey(collection({ lifecycle: "operational", hasTranslations: false }))).toBe(
      "collection.schemaSummary.plain",
    );
  });

  it("does not advertise publishing until the collection declares it", () => {
    expect(collectionSummaryKey(undefined)).toBe("collection.schemaSummary.plain");
  });
});

describe("contentLocales", () => {
  it("merges site, schema, and current locales without duplicates", () => {
    expect(contentLocales(
      { properties: { locale: { enum: ["en", "zh-TW"] } } },
      ["en", "ja"],
      "fr",
    )).toEqual(["en", "ja", "zh-TW", "fr"]);
  });

  it("shows at most three chips including overflow", () => {
    expect(splitLocaleChips(["en", "zh-TW", "ja"])).toEqual([["en", "zh-TW", "ja"], []]);
    expect(splitLocaleChips(["en", "zh-TW", "ja", "fr"])).toEqual([["en", "zh-TW"], ["ja", "fr"]]);
  });
});

describe("canEditEntry", () => {
  const access = (overrides: Partial<Parameters<typeof canEditEntry>[0]> = {}) => canEditEntry({
    admin: true,
    isReadOnly: false,
    isOperational: true,
    operationalEditUnlocked: false,
    ...overrides,
  });

  it("requires admin to explicitly unlock operational records", () => {
    expect(access()).toBe(false);
    expect(access({ operationalEditUnlocked: true })).toBe(true);
    expect(access({ admin: false, operationalEditUnlocked: true })).toBe(false);
    expect(access({ isReadOnly: true, operationalEditUnlocked: true })).toBe(false);
  });

  it("allows admin publishing edits but never grants a member access", () => {
    expect(access({ isOperational: false })).toBe(true);
    expect(access({ admin: false, isOperational: false })).toBe(false);
  });
});

describe("entryTitle", () => {
  it("uses the declared operational primary field when lifecycle is omitted", () => {
    const collection = {list: {primaryField: "orderNumber", columns: []}, schema: {properties: {}}};
    expect(entryTitle({title: "Publishing title", orderNumber: "Record 42"}, "Untitled", collection as unknown as Parameters<typeof entryTitle>[2], "id-42")).toBe("Record 42");
  });

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
    expect(stringFieldWidget({ type: "string", "x-mcp-hint": "markdown" }, null)).toBe("markdown");
    expect(stringFieldWidget({ type: "string", "x-mcp-hint": "html" }, null)).toBe("html");
    expect(stringFieldWidget({ type: "string", "x-mcp-hint": "richtext" }, null)).toBe("textarea");
  });
});

describe("readViewParams", () => {
  it("reads a URL parameter as its declared type, a nullable one too", () => {
    const schema = { type: "object", properties: { min: { type: ["integer", "null"] }, on: { type: "boolean" }, q: { type: "string" } } } as const;
    expect(readViewParams(schema as never, new URLSearchParams("min=3&on=true&q=tea"))).toEqual({ min: 3, on: true, q: "tea" });
  });
});
