import type { AdminExtensionInfo, ViewManifestInfo, Collection } from "../src/lib/types";
import { describe, expect, it } from "vitest";
import { isGroupActive, isLinkActive, isSubLinkActive } from "../src/layout/nav-group";
import { buildDeveloperNavGroups, buildNavGroups } from "../src/layout/authenticated-layout";
import type { NavCollapsible, NavLink } from "../src/layout/types";
import { initialsFor } from "../src/lib/initials";
import { foldedChildCollections, hasFoldedChildCollections, isFoldedFieldChild, entryEditPath, entryLandingPath } from "../src/lib/collection-nav";
import { shouldOpenParentWorkbench } from "../src/features/content/parent-entry-workbench";
const links: NavLink[] = [
  { title: "All", url: "/admin/c/orders" },
  { title: "Paid", url: "/admin/c/orders?filter_field=state&filter_value=paid" },
];

describe("sidebar collection filters", () => {
  it("selects the specific filter without also selecting All", () => {
    const search = "?filter_field=state&filter_value=paid&page=2";
    expect(isSubLinkActive(links[0]!, links, "/admin/c/orders", search)).toBe(false);
    expect(isSubLinkActive(links[1]!, links, "/admin/c/orders", search)).toBe(true);
  });

  it("keeps All selected for unrelated search and paging params", () => {
    expect(isSubLinkActive(links[0]!, links, "/admin/c/orders", "?search=86&page=2")).toBe(true);
  });

  it("keeps the collection and matching filter active on entry detail routes", () => {
    const group: NavCollapsible = { title: "Orders", items: links };
    expect(isLinkActive({ title: "Requests", url: "/admin/c/requests" }, "/admin/c/requests/request-1", "", true)).toBe(true);
    expect(isSubLinkActive(links[0]!, links, "/admin/c/orders/order-1", "")).toBe(true);
    expect(isSubLinkActive(links[0]!, links, "/admin/c/orders/order-1", "?filter_field=state&filter_value=paid")).toBe(false);
    expect(isSubLinkActive(links[1]!, links, "/admin/c/orders/order-1", "?filter_field=state&filter_value=paid")).toBe(true);
    expect(isGroupActive(group, "/admin/c/orders/order-1", "")).toBe(true);
  });
});

describe("member navigation", () => {
  it("uses records navigation unless publishing is explicitly declared", () => {
    const base = { lifecycle: "operational" as const, exportFields: [], name: "notes", title: "Notes", description: null, parent: null, localized: false, hasTranslations: false };
    Reflect.deleteProperty(base, "lifecycle");
    const missing = buildNavGroups([base], [], "en", null, true);
    expect(missing.find(group => group.title === "Records")?.items).toEqual([expect.objectContaining({url: "/admin/c/notes"})]);
    expect(JSON.stringify(missing)).not.toMatch(/\?status=/);
    const publishing = buildNavGroups([{...base, lifecycle: "publishing"}], [], "en", null, true);
    expect(JSON.stringify(publishing)).toContain("?status=draft");
  });

  const urlsFor = (admin: boolean) =>
    buildNavGroups([], [], "en", null, admin)
      .flatMap(({ items }) => items)
      .flatMap((item) => "url" in item ? [item.url] : []);

  it("shows management to admin and never grants it to a member", () => {
    expect(urlsFor(true)).toEqual(expect.arrayContaining(["/admin/members", "/admin/admin"]));
    expect(urlsFor(false)).not.toContain("/admin/members");
    expect(urlsFor(false)).not.toContain("/admin/admin");
  });

  it("hides settings a deployment did not turn on, and keeps Media, whose page is the setup guide", () => {
    const urls = (capabilities?: { siteSettings: boolean; media: boolean; invitationEmail: boolean; statistics: boolean }) =>
      buildNavGroups([], [], "en", null, true, false, capabilities).flatMap(({ items }) => items).flatMap((item) => "url" in item ? [item.url] : []);
    expect(urls({ siteSettings: false, media: false, invitationEmail: false, statistics: false })).not.toContain("/admin/settings");
    expect(urls({ siteSettings: false, media: false, invitationEmail: false, statistics: false })).toContain("/admin/media");
    expect(urls()).toEqual(expect.arrayContaining(["/admin/media", "/admin/settings"]));
  });

  it("keeps developer navigation out of Content Admin", () => {
    expect(JSON.stringify(buildNavGroups([], [], "en", null, true))).not.toContain("/admin/dev");
    const items = buildDeveloperNavGroups("en")[0]?.items ?? [];
    expect(items).toEqual([
      expect.objectContaining({ items: [expect.objectContaining({ url: "/admin/dev/overview/flow" }), expect.objectContaining({ url: "/admin/dev/overview/relationships" })] }),
      expect.objectContaining({ items: [expect.objectContaining({ url: "/admin/dev/model/schemas" }), expect.objectContaining({ url: "/admin/dev/model/views" })] }),
      expect.objectContaining({ items: [expect.objectContaining({ url: "/admin/dev/logic/triggers" }), expect.objectContaining({ url: "/admin/dev/logic/procedures" })] }),
      expect.objectContaining({ items: expect.arrayContaining([
        expect.objectContaining({ url: "/admin/dev/docs/api" }),
        expect.objectContaining({ url: "/admin/dev/docs/mcp" }),
        expect.objectContaining({ url: "/admin/dev/docs/webmcp" }),
      ]) }),
    ]);
  });

  it("lists every View of the manifest under Reports: the server lists admin Views only", () => {
    const view = (name: string): ViewManifestInfo => ({ name, title: null, description: null, input: null, list: { columns: [], searchFields: [], filterFields: [] }, columns: {} });
    const groups = buildNavGroups([], [view("admin-queue"), view("sales")], "en", null, true);
    expect(groups.find(({ title }) => title === "Reports")?.items).toEqual([
      expect.objectContaining({ url: "/admin/views/admin-queue" }),
      expect.objectContaining({ url: "/admin/views/sales" }),
    ]);
  });

  it("shows Operations only when a global operation exists", () => {
    expect(JSON.stringify(buildNavGroups([], [], "en", null, true))).not.toContain("/admin/operations");
    expect(JSON.stringify(buildNavGroups([], [], "en", null, true, true))).toContain("/admin/operations");
  });

  it("includes standalone folded children in main Nav without dropping parent collections", () => {
    const collection = (
      name: string,
      lifecycle: "publishing" | "operational",
      parent: { collection: string; parentField: string; childField: string } | null = null,
      nav: { standalone: true; parentField: string; parentCollection: string } | null = null,
    ) => ({
      name,
      title: name,
      description: null,
      lifecycle, exportFields: [],
      parent,
      nav,
      hasTranslations: false,
      localized: false,
    });
    const groups = buildNavGroups([
      collection("organizations", "operational"),
      collection("projects", "operational", { collection: "organizations", parentField: "id", childField: "organizationId" }, {
        standalone: true,
        parentField: "organizationId",
        parentCollection: "organizations",
      }),
      collection("members", "operational", { collection: "organizations", parentField: "id", childField: "organizationId" }),
    ], [], "en", null, true);
    const urls = (groups.find(({ title }) => title === "Records")?.items ?? [])
      .flatMap((item) => "url" in item ? [item.url] : item.items.map((link) => link.url));
    expect(urls).toEqual(expect.arrayContaining(["/admin/c/organizations", "/admin/c/projects"]));
    // Folded child collections stay out of the sidebar; they open from their parent entry's workbench.
    expect(urls).not.toContain("/admin/c/members");
  });
});

describe("extension pages and settings in the sidebar", () => {
  const extension = (contributes: Partial<AdminExtensionInfo["contributes"]>): AdminExtensionInfo => ({
    id: "admin-access", title: { en: "Admin access", "zh-TW": "Admin 權限" }, module: "/x/access.js",
    contributes: { pages: [], settings: [], actions: [], panels: [], fields: [], ...contributes },
  });

  it("lists settings first, then pages that ask for a place in order, localized, under More", () => {
    const groups = buildNavGroups([], [], "zh-TW", null, true, false, undefined, [extension({
      pages: [
        { id: "audit", title: "Audit", role: "admin", nav: { group: "more", order: 2 } },
        { id: "grants", title: { en: "Grants", "zh-TW": "授權" }, role: "admin", nav: { group: "more", order: 1 } },
        { id: "hidden", title: "Hidden", role: "admin" },
      ],
      settings: [{ id: "policy", title: { en: "Policy", "zh-TW": "政策" }, role: "admin", schema: { type: "object", properties: {} } }],
    })]);
    const more = groups[groups.length - 1]!;
    expect(more.items.flatMap((item) => "url" in item && item.url?.startsWith("/admin/x/") ? [[item.title, item.url]] : [])).toEqual([
      ["政策", "/admin/x/admin-access/policy"],
      ["授權", "/admin/x/admin-access/grants"],
      ["Audit", "/admin/x/admin-access/audit"],
    ]);
  });

  it("adds nothing when the server lists no extensions (or is older and sends none)", () => {
    const before = buildNavGroups([], [], "en", null, true);
    expect(buildNavGroups([], [], "en", null, true, false, undefined, [])).toEqual(before);
    expect(buildNavGroups([], [], "en", null, true, false, undefined, [extension({ panels: [{ id: "p", title: "P", role: "admin", target: "home/v1" }] })])).toEqual(before);
  });
});

describe("initialsFor", () => {
  it.each([
    ["local-admin", "LA"],
    ["guyspy", "GU"],
    ["Ada Lovelace", "AL"],
    [null, "?"],
  ])("turns %s into %s", (login, expected) => {
    expect(initialsFor(login)).toBe(expected);
  });
});

const orgFold = { collection: "organizations", parentField: "id", childField: "organizationId" } as const;

function collection(overrides: Partial<Collection>): Collection {
  return {
    name: "widgets",
    exportFields: [],
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
  it("folds only the composition field when another ref targets the same parent", () => {
    const projects = collection({ name: "projects", parent: orgFold });
    const relatedFields = ["billingOrganizationId", "organizationId", "secondaryOrganizationId"];
    expect(relatedFields.filter((field) => isFoldedFieldChild(projects, "organizations", field)))
      .toEqual(["organizationId"]);
    expect(isFoldedFieldChild(projects, "other-parent", "organizationId")).toBe(false);
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
