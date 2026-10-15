import type { ViewManifestInfo, Collection } from "../src/lib/types";
import { describe, expect, it } from "vitest";
import { isGroupActive, isLinkActive, isSubLinkActive } from "../src/layout/nav-group";
import { buildDeveloperNavGroups, buildNavGroups } from "../src/layout/authenticated-layout";
import type { ProjectNav } from "../src/app/project-nav";
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

describe("sidebar placement (uiSchema.nav and defineAdmin nav)", () => {
  const collection = (name: string, lifecycle: "operational" | "publishing", nav?: object) => ({ name, title: name, description: null, lifecycle, parent: null, localized: false, hasTranslations: false, exportFields: [], uiSchema: nav ? { nav } : null }) as never;
  const view = (name: string, nav?: object) => ({ name, title: name, description: null, input: null, list: { columns: [], searchFields: [], filterFields: [] }, columns: {}, ...(nav ? { nav } : {}) }) as never;
  const shape = (groups: ReturnType<typeof buildNavGroups>) => groups.map((g) => [g.title ?? "", g.items.map((i) => i.title)]);

  it("keeps Admin's default grouping when nothing is placed", () => {
    expect(shape(buildNavGroups([collection("posts", "publishing"), collection("orders", "operational")], [view("open-orders")], "en", null, false)).slice(1))
      .toEqual([["Content", ["posts"]], ["Records", ["orders"]], ["Reports", ["open-orders"]]]);
  });

  it("orders entries, moves them into project groups ordered among the built-in ones, and hides entries", () => {
    const groups = buildNavGroups(
      [collection("types", "operational", { group: "catalog", order: 1 }), collection("categories", "operational", { group: "catalog", order: 2 }), collection("quotes", "operational", { group: "sales" }), collection("audit", "operational", { hidden: true }), collection("customers", "operational")],
      [view("pipeline", { group: "sales", order: 1 }), view("totals")],
      "en", null, false, false, undefined,
      { groups: { sales: { title: { en: "Sales", "zh-TW": "業務" }, order: 5 }, catalog: { title: "Catalog" } }, items: [] },
    );
    expect(shape(groups).slice(1)).toEqual([
      ["Sales", ["pipeline", "quotes"]],
      ["Records", ["customers"]],
      ["Reports", ["totals"]],
      ["Catalog", ["types", "categories"]],
    ]);
    expect(JSON.stringify(groups)).not.toContain("/admin/c/audit");
  });

  it("shows no empty Content heading once a project moves every collection out of it", () => {
    const groups = buildNavGroups([collection("posts", "publishing", { group: "editorial" })], [], "en", null, false, false, undefined, { groups: { editorial: { title: "Editorial" } }, items: [] });
    expect(shape(groups).slice(1)).toEqual([["Editorial", ["posts"]]]);
    expect(shape(buildNavGroups([], [], "en", null, false)).slice(1)).toEqual([["Content", []]]);
    expect(shape(buildNavGroups([collection("archive", "operational", { group: "more" })], [], "en", null, false)).slice(1)).toEqual([["More", ["archive"]]]);
  });

  describe("defineAdmin nav", () => {
    const project = (nav: Partial<ProjectNav> = {}): ProjectNav => ({ groups: {}, items: [], ...nav });
    const build = (nav: ProjectNav, collections = [collection("requests", "operational"), collection("posts", "publishing")], views = [view("pending")]) =>
      buildNavGroups(collections, views, "en", null, false, false, undefined, nav);
    const links = (groups: ReturnType<typeof buildNavGroups>, title: string) => groups.find((g) => g.title === title)?.items as NavLink[] | undefined;

    it("declares groups, localised and ordered among the built-in ones", () => {
      const nav = project({ groups: { approvals: { title: { en: "Approvals", "zh-TW": "簽核" }, order: 5 }, desk: { title: "New desk" } }, items: [{ group: "approvals", title: "Waiting", to: { view: "pending" } }, { group: "desk", title: "Requests", to: { collection: "requests" } }] });
      expect(shape(build(nav)).slice(1)).toEqual([["Approvals", ["Waiting"]], ["Content", ["posts"]], ["Records", ["requests"]], ["Reports", ["pending"]], ["New desk", ["Requests"]]]);
    });

    it("places an application page in its group by order, beside the items; a page without nav stays out of the sidebar", () => {
      const nav = project({ groups: { approvals: { title: "Approvals" } }, items: [{ group: "approvals", title: "Waiting", order: 1, to: { view: "pending" } }],
        pages: [{ path: "budget", title: { en: "Budget" }, element: null, nav: { group: "approvals", order: 2 } }, { path: "hidden", title: "Hidden", element: null }] });
      const groups = build(nav);
      expect(links(groups, "Approvals")!.map((l) => [l.title, l.url])).toEqual([["Waiting", "/admin/views/pending"], ["Budget", "/admin/p/budget"]]);
      expect(JSON.stringify(groups)).not.toContain("/admin/p/hidden");
    });

    it("leads items to a collection preset to one field's value, or to a View with its input", () => {
      const nav = project({ items: [
        { group: "content", title: "Rejected", to: { collection: "requests", filter: { status: "rejected" } } },
        { group: "content", title: "All requests", to: { collection: "requests" } },
        { group: "reports", title: "Mine", order: 1, to: { view: "pending", input: { owner: "me", limit: 5, flag: true, skip: undefined, nested: { a: 1 } } } },
      ] });
      const groups = build(nav);
      expect(links(groups, "Content")!.filter((l) => l.title !== "posts").map((l) => [l.title, l.url])).toEqual([["Rejected", "/admin/c/requests?filter_field=status&filter_value=rejected"], ["All requests", "/admin/c/requests"]]);
      expect(links(groups, "Reports")!.map((l) => [l.title, l.url])).toEqual([["Mine", "/admin/views/pending?owner=me&limit=5&flag=true"], ["pending", "/admin/views/pending"]]);
    });

    it("shows no item whose collection or View the caller cannot see, and adds no permission", () => {
      const nav = project({ items: [{ group: "content", title: "Secret", to: { collection: "secrets" } }, { group: "reports", title: "Hidden view", to: { view: "private" } }] });
      expect(JSON.stringify(build(nav))).not.toMatch(/Secret|Hidden view|secrets|private/);
      // visible only because the server listed it: an item for a visible resource appears with the same url as the default entry
      expect(links(build(project({ items: [{ group: "content", title: "Req", to: { collection: "requests" } }] })), "Content")!.map((l) => l.title)).toContain("Req");
    });

    it("ignores a declaration of Admin's own group ids, so More is not listed twice", () => {
      const groups = build(project({ groups: { more: { title: "Extras" }, reports: { title: "Mine", order: 1 } } }), [], [view("pending")]);
      expect(shape(groups).slice(1)).toEqual([["Reports", ["pending"]]]);
    });

    it("titles a group nobody declared by its id instead of dropping its items", () => {
      const groups = build(project(), [collection("requests", "operational", { group: "approvals" })], []);
      expect(shape(groups).slice(1)).toEqual([["Approvals", ["requests"]]]);
    });
  });
});
