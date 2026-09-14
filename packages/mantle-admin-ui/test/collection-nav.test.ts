import { describe, expect, it } from "vitest";
import {
  foldedChildCollections,
  hasFoldedChildCollections,
  isPrimaryNavCollection,
  entryEditPath,
  entryLandingPath,
} from "../src/lib/collection-nav";
import { shouldOpenParentWorkbench } from "../src/features/content/parent-entry-workbench";
import type { Collection } from "../src/lib/types";

function collection(overrides: Partial<Collection>): Collection {
  return {
    name: "widgets",
    title: "Widgets",
    description: null,
    lifecycle: "publishing",
    hasTranslations: false,
    localized: false,
    parent: null,
    nav: null,
    translates: null,
    ...overrides,
  };
}

describe("collection nav helpers", () => {
  it("keeps folded children out of main Nav unless standalone is set", () => {
    const child = collection({
      name: "projects",
      parent: { collection: "organizations", parentField: "id", childField: "organizationId" },
    });
    expect(isPrimaryNavCollection(child)).toBe(false);
    expect(isPrimaryNavCollection({
      ...child,
      nav: { standalone: true, parentField: "organizationId", parentCollection: "organizations" },
    })).toBe(true);
    expect(isPrimaryNavCollection(collection({ name: "organizations" }))).toBe(true);
  });

  it("discovers folded children for the parent workbench without unfolding", () => {
    const collections = [
      collection({ name: "organizations" }),
      collection({
        name: "projects",
        parent: { collection: "organizations", parentField: "id", childField: "organizationId" },
        nav: { standalone: true, parentField: "organizationId", parentCollection: "organizations" },
      }),
      collection({
        name: "members",
        parent: { collection: "organizations", parentField: "id", childField: "organizationId" },
      }),
    ];
    expect(foldedChildCollections(collections, "organizations").map((item) => item.name))
      .toEqual(["projects", "members"]);
    expect(hasFoldedChildCollections(collections, "organizations")).toBe(true);
    expect(shouldOpenParentWorkbench(collections, "organizations")).toBe(true);
    expect(shouldOpenParentWorkbench(collections, "projects")).toBe(false);
    expect(entryLandingPath("organizations", "org-1")).toBe("/admin/c/organizations/org-1");
    expect(entryEditPath("organizations", "org-1")).toBe("/admin/c/organizations/org-1/edit");
    expect(entryEditPath("organizations", "org-1")).not.toBe(entryLandingPath("organizations", "org-1"));
  });

  it("does not open the workbench for a parent that only has translation children", () => {
    const collections = [
      collection({ name: "posts", hasTranslations: true }),
      collection({
        name: "post-translations",
        localized: true,
        parent: { collection: "posts", parentField: "slug", childField: "slug" },
        translates: { parent: "posts", on: "slug" },
      }),
    ];
    expect(foldedChildCollections(collections, "posts")).toEqual([]);
    expect(hasFoldedChildCollections(collections, "posts")).toBe(false);
    expect(shouldOpenParentWorkbench(collections, "posts")).toBe(false);
  });

  it("opens the workbench when a required-ref child is folded, even if translations also exist", () => {
    const collections = [
      collection({ name: "organizations", hasTranslations: true }),
      collection({
        name: "organization-translations",
        localized: true,
        parent: { collection: "organizations", parentField: "name", childField: "name" },
        translates: { parent: "organizations", on: "name" },
      }),
      collection({
        name: "projects",
        parent: { collection: "organizations", parentField: "id", childField: "organizationId" },
      }),
    ];
    expect(foldedChildCollections(collections, "organizations").map((item) => item.name))
      .toEqual(["projects"]);
    expect(shouldOpenParentWorkbench(collections, "organizations")).toBe(true);
  });
});
