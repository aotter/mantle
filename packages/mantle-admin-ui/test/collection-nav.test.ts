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

const orgFold = { collection: "organizations", parentField: "id", childField: "organizationId" } as const;

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
    const child = collection({ name: "projects", parent: orgFold });
    expect(isPrimaryNavCollection(child)).toBe(false);
    expect(isPrimaryNavCollection({
      ...child,
      nav: { standalone: true, parentField: "organizationId", parentCollection: "organizations" },
    })).toBe(true);
    expect(isPrimaryNavCollection(collection({ name: "organizations" }))).toBe(true);
  });

  it("discovers required-ref children for the parent workbench without unfolding", () => {
    const collections = [
      collection({ name: "organizations" }),
      collection({
        name: "projects",
        parent: orgFold,
        nav: { standalone: true, parentField: "organizationId", parentCollection: "organizations" },
      }),
      collection({ name: "members", parent: orgFold }),
    ];
    expect(foldedChildCollections(collections, "organizations").map((item) => item.name))
      .toEqual(["projects", "members"]);
    expect(hasFoldedChildCollections(collections, "organizations")).toBe(true);
    expect(shouldOpenParentWorkbench(collections, "organizations")).toBe(true);
    expect(shouldOpenParentWorkbench(collections, "projects")).toBe(false);
    expect(entryLandingPath("organizations", "org-1")).toBe("/admin/c/organizations/org-1");
    expect(entryEditPath("organizations", "org-1")).toBe("/admin/c/organizations/org-1/edit");
  });

  it.each([
    {
      name: "translation-only parent",
      collections: [
        collection({ name: "posts", hasTranslations: true }),
        collection({
          name: "post-translations",
          localized: true,
          parent: { collection: "posts", parentField: "slug", childField: "slug" },
          translates: { parent: "posts", on: "slug" },
        }),
      ],
      parent: "posts",
      folded: [] as string[],
      workbench: false,
    },
    {
      name: "required-ref child plus translations",
      collections: [
        collection({ name: "organizations", hasTranslations: true }),
        collection({
          name: "organization-translations",
          localized: true,
          parent: { collection: "organizations", parentField: "name", childField: "name" },
          translates: { parent: "organizations", on: "name" },
        }),
        collection({ name: "projects", parent: orgFold }),
      ],
      parent: "organizations",
      folded: ["projects"],
      workbench: true,
    },
  ])("workbench: $name", ({ collections, parent, folded, workbench }) => {
    expect(foldedChildCollections(collections, parent).map((item) => item.name)).toEqual(folded);
    expect(shouldOpenParentWorkbench(collections, parent)).toBe(workbench);
  });
});
