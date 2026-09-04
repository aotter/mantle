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

  it("does not create a standalone operations destination", () => {
    const groups = buildNavGroups([], [], "en", null, "owner");
    expect(JSON.stringify(groups)).not.toContain("/admin/ops");
  });

  it("keeps developer navigation out of Content Admin", () => {
    expect(JSON.stringify(buildNavGroups([], [], "en", null, "owner"))).not.toContain("/admin/dev");
    expect(buildDeveloperNavGroups("en")[0]?.items).toEqual([
      expect.objectContaining({ url: "/admin/dev" }),
      expect.objectContaining({ url: "/admin/dev/model" }),
      expect.objectContaining({ url: "/admin/dev/logic" }),
      expect.objectContaining({ url: "/admin/dev/docs" }),
    ]);
  });

  it("separates public services from staff Reports", () => {
    const view = (name: string, surface: ViewManifestInfo["surface"]): ViewManifestInfo => ({ name, surface, title: null, from: null, params: null, fields: null, list: { columns: [], searchFields: [], filterFields: [] } });
    const groups = buildNavGroups([], [view("public-catalog", "public"), view("staff-queue", "staff")], "en", null, "owner");
    expect(groups.find(({ title }) => title === "Public services")?.items).toEqual([
      expect.objectContaining({ url: "/admin/views/public-catalog" }),
    ]);
    expect(groups.find(({ title }) => title === "Reports")?.items).toEqual([
      expect.objectContaining({ url: "/admin/views/staff-queue" }),
    ]);
    expect(groups.find(({ title }) => title === "Public services")?.items[0]?.icon)
      .not.toBe(groups.find(({ title }) => title === "Reports")?.items[0]?.icon);
  });
});
