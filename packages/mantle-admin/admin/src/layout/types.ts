export type { AdminBrand, NavCollapsible, NavGroupData, NavItem, NavLink } from "../app/slot-props";
import type { NavCollapsible, NavItem } from "../app/slot-props";

export function isCollapsible(item: NavItem): item is NavCollapsible {
  return Array.isArray((item as NavCollapsible).items);
}
