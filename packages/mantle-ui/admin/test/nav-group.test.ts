import type { AdminExtensionInfo } from "../src/lib/types";
import { describe, expect, it } from "vitest";
import { isGroupActive, isLinkActive, isSubLinkActive } from "../src/layout/nav-group";
import { buildDeveloperNavGroups, buildNavGroups } from "../src/layout/authenticated-layout";
import type { ViewManifestInfo } from "../src/lib/types";
import type { NavCollapsible, NavLink } from "../src/layout/types";

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
  const urlsFor = (role: "owner" | "editor" | "contributor") =>
    buildNavGroups([], [], "en", null, role)
      .flatMap(({ items }) => items)
      .flatMap((item) => "url" in item ? [item.url] : []);

  it("shows members to editors and owners, while team management stays owner-only", () => {
    expect(urlsFor("editor")).toContain("/admin/members");
    expect(urlsFor("editor")).not.toContain("/admin/staff");
    expect(urlsFor("owner")).toEqual(expect.arrayContaining(["/admin/members", "/admin/staff"]));
    expect(urlsFor("contributor")).not.toContain("/admin/members");
  });

  it("hides settings a deployment did not turn on, and keeps Media, whose page is the setup guide", () => {
    const urls = (capabilities?: { siteSettings: boolean; media: boolean; invitationEmail: boolean; statistics: boolean }) =>
      buildNavGroups([], [], "en", null, "owner", false, capabilities).flatMap(({ items }) => items).flatMap((item) => "url" in item ? [item.url] : []);
    expect(urls({ siteSettings: false, media: false, invitationEmail: false, statistics: false })).not.toContain("/admin/settings");
    expect(urls({ siteSettings: false, media: false, invitationEmail: false, statistics: false })).toContain("/admin/media");
    expect(urls()).toEqual(expect.arrayContaining(["/admin/media", "/admin/settings"]));
  });

  it("does not create a standalone operations destination", () => {
    const groups = buildNavGroups([], [], "en", null, "owner");
    expect(JSON.stringify(groups)).not.toContain("/admin/ops");
  });

  it("keeps developer navigation out of Content Admin", () => {
    expect(JSON.stringify(buildNavGroups([], [], "en", null, "owner"))).not.toContain("/admin/dev");
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

  it("lists every View of the manifest under Reports: the server lists staff Views only", () => {
    const view = (name: string): ViewManifestInfo => ({ name, title: null, description: null, input: null, list: { columns: [], searchFields: [], filterFields: [] }, columns: {} });
    const groups = buildNavGroups([], [view("staff-queue"), view("sales")], "en", null, "owner");
    expect(groups.find(({ title }) => title === "Reports")?.items).toEqual([
      expect.objectContaining({ url: "/admin/views/staff-queue" }),
      expect.objectContaining({ url: "/admin/views/sales" }),
    ]);
  });

  it("shows Operations only when a global operation exists", () => {
    expect(JSON.stringify(buildNavGroups([], [], "en", null, "owner"))).not.toContain("/admin/operations");
    expect(JSON.stringify(buildNavGroups([], [], "en", null, "owner", true))).toContain("/admin/operations");
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
      lifecycle,
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
    ], [], "en", null, "owner");
    const urls = (groups.find(({ title }) => title === "Records")?.items ?? [])
      .flatMap((item) => "url" in item ? [item.url] : item.items.map((link) => link.url));
    expect(urls).toEqual(expect.arrayContaining(["/admin/c/organizations", "/admin/c/projects"]));
    expect(urls).not.toContain("/admin/c/members");
  });
});

describe("extension pages and settings in the sidebar", () => {
  const extension = (contributes: Partial<AdminExtensionInfo["contributes"]>): AdminExtensionInfo => ({
    id: "staff-access", title: { en: "Staff access", "zh-TW": "Staff 權限" }, module: "/x/access.js",
    contributes: { pages: [], settings: [], actions: [], panels: [], fields: [], ...contributes },
  });

  it("lists settings first, then pages that ask for a place in order, localized, under More", () => {
    const groups = buildNavGroups([], [], "zh-TW", null, "contributor", false, undefined, [extension({
      pages: [
        { id: "audit", title: "Audit", role: "contributor", nav: { group: "more", order: 2 } },
        { id: "grants", title: { en: "Grants", "zh-TW": "授權" }, role: "contributor", nav: { group: "more", order: 1 } },
        { id: "hidden", title: "Hidden", role: "contributor" },
      ],
      settings: [{ id: "policy", title: { en: "Policy", "zh-TW": "政策" }, role: "contributor", schema: { type: "object", properties: {} } }],
    })]);
    const more = groups[groups.length - 1]!;
    expect(more.items.map((item) => "url" in item ? [item.title, item.url] : [])).toEqual([
      ["政策", "/admin/x/staff-access/policy"],
      ["授權", "/admin/x/staff-access/grants"],
      ["Audit", "/admin/x/staff-access/audit"],
    ]);
  });

  it("adds nothing when the server lists no extensions (or is older and sends none)", () => {
    const before = buildNavGroups([], [], "en", null, "owner");
    expect(buildNavGroups([], [], "en", null, "owner", false, undefined, [])).toEqual(before);
    expect(buildNavGroups([], [], "en", null, "owner", false, undefined, [extension({ panels: [{ id: "p", title: "P", role: "owner", target: "home/v1" }] })])).toEqual(before);
  });
});
