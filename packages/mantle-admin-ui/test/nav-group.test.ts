import { describe, expect, it } from "vitest";
import { isSubLinkActive } from "../src/layout/nav-group";
import type { NavLink } from "../src/layout/types";

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
});
