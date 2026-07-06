import { describe, expect, it } from "vitest";
import { collectionSummaryKey } from "../src/features/content/collection-view";
import type { Collection } from "../src/lib/types";

/**
 * #444 item 5 — the collection-page subtitle used to say "items,
 * publishing state, and localized content" for every collection,
 * including `lifecycle: "none"` ones that have neither a publish
 * workflow nor translations. `collectionSummaryKey` picks one of four
 * i18n keys from capabilities the UI already has on hand
 * (`lifecycle`, `hasTranslations`) — this locks in that mapping so a
 * future edit can't silently go back to one-size-fits-all copy.
 */

function collection(overrides: Partial<Collection>): Collection {
  return {
    name: "widgets",
    title: "Widgets",
    description: null,
    lifecycle: "simple",
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
    expect(collectionSummaryKey(collection({ lifecycle: "simple", hasTranslations: false }))).toBe(
      "collection.schemaSummary.lifecycleOnly",
    );
  });

  it("picks the i18n-only variant for lifecycle:none collections that still have translations", () => {
    expect(collectionSummaryKey(collection({ lifecycle: "none", hasTranslations: true }))).toBe(
      "collection.schemaSummary.i18nOnly",
    );
  });

  it("picks the plain variant for lifecycle:none collections with no translations", () => {
    expect(collectionSummaryKey(collection({ lifecycle: "none", hasTranslations: false }))).toBe(
      "collection.schemaSummary.plain",
    );
  });

  it("treats an undefined collection as having a lifecycle (loading state, not an operational record)", () => {
    expect(collectionSummaryKey(undefined)).toBe("collection.schemaSummary.lifecycleOnly");
  });
});
