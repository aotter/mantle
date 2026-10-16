import type * as React from "react";
import type { AdminEntry } from "./hooks";

/** A link in Admin's sidebar. */
export interface NavLink {
  readonly title: string;
  readonly url: string;
  readonly icon?: React.ElementType;
  /** Small trailing icon after the title, marking a row with a secondary attribute. */
  readonly marker?: React.ElementType;
  readonly markerLabel?: string;
  readonly external?: boolean;
  /** A count after the title: `field` of the first row of this aggregate admin View, read as the caller (`useBadges`). */
  readonly badge?: { readonly view: string; readonly field: string };
}

/** A sidebar entry that opens a list of links. */
export interface NavCollapsible {
  readonly title: string;
  readonly icon?: React.ElementType;
  /** See `NavLink.marker`. */
  readonly marker?: React.ElementType;
  readonly markerLabel?: string;
  readonly items: ReadonlyArray<NavLink>;
}

export type NavItem = NavLink | NavCollapsible;

/** One titled group of the sidebar. */
export interface NavGroupData {
  readonly title?: string;
  readonly items: ReadonlyArray<NavItem>;
}

/** The title, image and home link of the console. */
export interface AdminBrand {
  readonly title: string;
  readonly image?: string | null;
  readonly href?: string;
}

/** A collection as the home page lists it: the parts a replacement needs. */
export interface AdminCollectionSummary {
  readonly name: string;
  readonly title: string | Readonly<Record<string, string>>;
  readonly lifecycle: string;
}

/** The site as the home page shows it. */
export interface AdminSiteSummary {
  readonly title: string;
  readonly brand: string;
  readonly publicUrl: string;
}

/** `Shell`: the frame around every page: sidebar, header and the routed `children`. Surface: browser. */
export interface ShellProps {
  readonly children: React.ReactNode;
  readonly nav: ReadonlyArray<NavGroupData>;
  readonly brand: AdminBrand;
}

/** `Sidebar`: navigation. `footer` renders above the signed-in user. Surface: browser. */
export interface SidebarProps {
  readonly groups: ReadonlyArray<NavGroupData>;
  readonly brand: AdminBrand;
  readonly footer?: React.ReactNode;
}

/** `Header`: the bar above a page. `actions` render before the built-in controls. Surface: browser. */
export interface HeaderProps {
  readonly title?: string | undefined;
  readonly actions?: React.ReactNode;
}

/** `Brand`: the console's name and image at the top of the sidebar. Surface: browser. */
export type BrandProps = AdminBrand;

/** `Home`: the page at `/admin`. Surface: browser. */
export interface HomeProps {
  readonly collections: ReadonlyArray<AdminCollectionSummary>;
  readonly site: AdminSiteSummary | undefined;
}

/** `CollectionList`: a collection's list page, which reads its filters from the location. Surface: browser. */
export interface CollectionListProps {
  readonly collection: string;
}

/** `RecordView`: one entry's page, which loads the entry itself. Surface: browser. */
export interface RecordViewProps {
  readonly collection: string;
  readonly entryId: string;
}

/** The surface a `both` slot renders in. */
export interface SurfaceProp {
  readonly surface: "browser" | "mcp-app";
}

/** `record.aside:<schema>`: beside a record's form, in the browser's record page. Surface: browser. */
export interface RecordAsideProps<Data = Readonly<Record<string, unknown>>> {
  readonly collection: string;
  readonly entry: AdminEntry<Data>;
}

/** `record.actions:<schema>`: buttons in a record's header. Surface: browser. */
export interface RecordActionsProps<Data = Readonly<Record<string, unknown>>> {
  readonly collection: string;
  readonly entry: AdminEntry<Data>;
}

/** `list.actions:<schema>`: buttons in a list's toolbar, and for the rows selected. Surface: browser. */
export interface ListActionsProps {
  readonly collection: string;
  /** The selected rows' ids; empty in the toolbar. */
  readonly selection: ReadonlyArray<string>;
}

/** `cell:<schema>.<field>` and `cell:view:<view>.<column>`: one value in a list or report. Surface: browser for collection cells; both for View cells. */
export interface CellProps<Value = unknown, Row = Readonly<Record<string, unknown>>> {
  readonly value: Value;
  readonly row: Row;
  /** The field's JSON Schema property, when there is one. */
  readonly property: Readonly<Record<string, unknown>> | undefined;
}

/** `input:<schema>.<field>`: the control of one field in the record form. Surface: browser. This is not a Procedure action input. */
export interface InputProps<Value = unknown> {
  readonly value: Value;
  readonly onChange: (next: Value) => void;
  /** The form cannot be edited by this caller. */
  readonly readOnly: boolean;
  readonly property: Readonly<Record<string, unknown>>;
}
