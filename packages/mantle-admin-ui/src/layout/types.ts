import type { ElementType } from "react";

export interface NavLink {
  readonly title: string;
  readonly url: string;
  readonly icon?: ElementType;
  /** Small trailing icon after the title —
   *  used to mark a row with a secondary attribute (e.g. globe icon
   *  on collections that have translation children) without
   *  displacing the leading `icon` slot. */
  readonly marker?: ElementType;
  readonly markerLabel?: string;
  readonly external?: boolean;
}

export interface NavCollapsible {
  readonly title: string;
  readonly icon?: ElementType;
  /** See `NavLink.marker`. */
  readonly marker?: ElementType;
  readonly markerLabel?: string;
  readonly items: ReadonlyArray<NavLink>;
}

export type NavItem = NavLink | NavCollapsible;

export function isCollapsible(item: NavItem): item is NavCollapsible {
  return Array.isArray((item as NavCollapsible).items);
}

export interface NavGroupData {
  readonly title?: string;
  readonly items: ReadonlyArray<NavItem>;
}

export interface AdminBrand {
  readonly title: string;
  readonly image?: string;
  readonly href?: string;
}
