import { describe, expect, it } from "vitest";
import { collectionSummaryKey } from "../src/features/content/collection-view";
import type { Collection } from "../src/lib/types";

function collection(overrides: Partial<Collection>): Collection {
  return {
    name: "widgets",
    title: "Widgets",
    description: null,
    lifecycle: "publishing",
    hasTranslations: false,
    ...overrides,
  };
}

describe("collectionSummaryKey", () => {
  it("picks the lifecycle+i18n variant when both capabilities are present", () => {
    expect(collectionSummaryKey(collection({ lifecycle: "editorial", hasTranslations: true }))).toBe(
      "collection.schemaSummary.lifecycleAndI18n",
    );
  });

  it("picks the lifecycle-only variant when there's a publish workflow but no translations", () => {
    expect(collectionSummaryKey(collection({ lifecycle: "publishing", hasTranslations: false }))).toBe(
      "collection.schemaSummary.lifecycleOnly",
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

  it("treats an undefined collection as having a lifecycle (loading state, not an operational record)", () => {
    expect(collectionSummaryKey(undefined)).toBe("collection.schemaSummary.lifecycleOnly");
  });
});
