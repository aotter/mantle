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

/** A sign-in method as `GET <auth>/methods` lists it (`authRoutes` `methods`). */
export type SignInMethod =
  | { readonly kind: "email-otp" }
  | { readonly kind: "magic-link" }
  | { readonly kind: "passkey" }
  | { readonly kind: "social"; readonly provider: string }
  | { readonly kind: "oauth"; readonly providerId: string; readonly displayName?: string };

/**
 * `SignIn`: the methods on `/admin/sign-in`, below the card's title. Surface: browser. Pass changed props to
 * `renderDefault` to reorder or drop `methods` or to set `emailAutoComplete`; render your own elements around it to add a
 * method of your own. A `passkey` method is listed for this slot: the default renders nothing for it.
 */
export interface SignInProps {
  readonly methods: readonly SignInMethod[];
  /** The same-origin path to land on after signing in (`?return=`, else `/admin`). */
  readonly returnTo: string;
  /** The signed OAuth authorize query when this sign-in continues an authorization (an MCP connector's), else undefined. */
  readonly oauthQuery: string | undefined;
  /** The email input's `autocomplete` for the email-code method; `email` by default. */
  readonly emailAutoComplete: string;
  /**
   * Called once the email code has signed in, with where to go next: the OAuth authorize
   * continuation, or `returnTo`. The default navigates there. Wrap it to run a step of your own first and then navigate
   * to the same URL unchanged. Redirecting methods (social, OAuth, magic
   * link) leave the page and do not call it. The signed-in method stays locked (its code is spent, its button busy), so
   * navigate away, or replace the page, rather than leaving the sign-in card in place.
   */
  readonly onSignedIn: (next: string) => void;
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

/** A custom input's current validation and local draft, independent of the value last emitted through `onChange`. */
export interface InputStatus {
  readonly error?: string | null;
  readonly dirty?: boolean;
}

/** `input:<schema>.<field>`: the control of one field in the record form. Surface: browser. This is not a Procedure action input. */
export interface InputProps<Value = unknown> {
  readonly value: Value;
  readonly onChange: (next: Value) => void;
  /** The form cannot be edited by this caller. */
  readonly readOnly: boolean;
  readonly property: Readonly<Record<string, unknown>>;
  /** Replace this mounted input's status; omit it (or pass {}) to clear. This never grants edit access. */
  readonly onStatusChange?: (status?: InputStatus) => void;
  /** The reported error, rendered by Admin; link your control to errorId and set aria-invalid when present. */
  readonly error?: string;
  readonly errorId?: string;
}
