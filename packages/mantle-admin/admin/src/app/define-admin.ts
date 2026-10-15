import type { AdminLayers, SlotComponent } from "./slots";
import type { BrandProps, CellProps, CollectionListProps, HeaderProps, HomeProps, InputProps, ListActionsProps, RecordActionsProps, RecordAsideProps, RecordViewProps, ShellProps, SidebarProps, SurfaceProp } from "./slot-props";

/**
 * What `generated/admin-client.ts` knows about an application, as types: the input and row of each admin View, the
 * `data` of each collection's entries, and the input and output of each admin operation. The built-in entry has no
 * generated types, so its names are any string and its shapes are open.
 */
export interface AdminTypes {
  readonly views: { readonly [name: string]: { readonly input: object; readonly row: object } };
  readonly collections: { readonly [name: string]: { readonly data: object } };
  readonly operations: { readonly [name: string]: { readonly input: object; readonly output: unknown } };
}

/**
 * Generated Admin metadata for `defineAdmin`: the column names each View's rows carry in the browser where they differ from
 * the SQL output names an MCP tool returns, so an MCP App's rows match the browser's. It names columns only; it grants and
 * denies nothing. The built-in entry has none.
 */
export interface AdminMeta<T extends AdminTypes = AdminTypes> {
  readonly rowNames?: { readonly [N in keyof T["views"]]?: { readonly [column: string]: string } };
}

/** A component for a slot that renders in the browser only. */
type Browser<P> = SlotComponent<P>;
/** A component for a slot that renders in the browser and in an MCP host: its props carry `surface`. */
type Both<P> = SlotComponent<P, SurfaceProp>;

type Name<K> = K & string;
type Collections<T extends AdminTypes> = Name<keyof T["collections"]>;
type Views<T extends AdminTypes> = Name<keyof T["views"]>;
/** The keys of an object type; any name for the open shape the built-in entry has. */
type Keys<O> = [keyof O] extends [never] ? string : Name<keyof O>;
/** `<collection>.<field>` for every field of every collection. */
type FieldKey<T extends AdminTypes> = { [C in Collections<T>]: `${C}.${Keys<T["collections"][C]["data"]>}` }[Collections<T>];
/** `<view>.<column>` for every column of every admin View. */
type ColumnKey<T extends AdminTypes> = { [V in Views<T>]: `${V}.${Keys<T["views"][V]["row"]>}` }[Views<T>];
type DataOf<T extends AdminTypes, C extends string> = C extends keyof T["collections"] ? T["collections"][C]["data"] : never;
type FieldOf<T extends AdminTypes, K extends string> = K extends `${infer C}.${infer F}` ? Member<DataOf<T, C>, F> : never;
/** A member's type; `unknown` for the open shape the built-in entry has. */
type Member<O, F extends string> = [keyof O] extends [never] ? unknown : F extends keyof O ? O[F] : never;
type RowOf<T extends AdminTypes, V extends string> = V extends keyof T["views"] ? T["views"][V]["row"] : never;
type ColumnOf<T extends AdminTypes, K extends string> = K extends `${infer V}.${infer F}` ? Member<RowOf<T, V>, F> : never;
type Of<K extends string, Prefix extends string> = K extends `${Prefix}${infer Rest}` ? Rest : never;

/**
 * The regions of Admin an application can replace or wrap. Each component receives the props of the built-in one and
 * `renderDefault(props)`, which renders what it replaces. Slot names and props are versioned with the package; a misspelt
 * name fails `tsc`. In a key, `<schema>` is a collection's name, `<field>` one of its fields (names contain no `.`), and
 * `<view>.<column>` a column of an admin View.
 *
 * Surface: `Shell`, `Sidebar`, `Header`, `Brand`, `Home`, `CollectionList` and `list.actions:` exist in the browser only.
 * `RecordView`, `record.aside:`, `record.actions:`, `cell:` and `input:` render in an MCP host too: read data only through
 * the hooks, link only with `<AdminLink>` or `useOpenLink()`, and expect no particular width.
 */
export type AdminComponents<T extends AdminTypes = AdminTypes> = {
  readonly Shell?: Browser<ShellProps>;
  readonly Sidebar?: Browser<SidebarProps>;
  readonly Header?: Browser<HeaderProps>;
  readonly Brand?: Browser<BrandProps>;
  readonly Home?: Browser<HomeProps>;
  readonly CollectionList?: Browser<CollectionListProps>;
  readonly RecordView?: Both<RecordViewProps>;
} & {
  readonly [K in `record.aside:${Collections<T>}`]?: Both<RecordAsideProps<DataOf<T, Of<K, "record.aside:">>>>;
} & {
  readonly [K in `record.actions:${Collections<T>}`]?: Both<RecordActionsProps<DataOf<T, Of<K, "record.actions:">>>>;
} & {
  readonly [K in `list.actions:${Collections<T>}`]?: Browser<ListActionsProps>;
} & {
  readonly [K in `cell:${FieldKey<T>}`]?: Both<CellProps<FieldOf<T, Of<K, "cell:">>, DataOf<T, Of<K, "cell:"> extends `${infer C}.${string}` ? C : never>>>;
} & {
  readonly [K in `cell:view:${ColumnKey<T>}`]?: Both<CellProps<ColumnOf<T, Of<K, "cell:view:">>, RowOf<T, Of<K, "cell:view:"> extends `${infer V}.${string}` ? V : never>>>;
} & {
  readonly [K in `input:${FieldKey<T>}`]?: Both<InputProps<FieldOf<T, Of<K, "input:">>>>;
};

/** A reusable fragment of `defineAdmin`'s `components`, such as an audit trail panel. */
export interface AdminPlugin {
  readonly components?: AdminComponents;
}

/** The domains an MCP App may load from, as the host's CSP (`_meta.ui.csp`). A type only until Admin's MCP App is built from the application's entry. */
export interface AdminMcpCsp {
  readonly connectDomains?: readonly string[];
  readonly resourceDomains?: readonly string[];
  readonly frameDomains?: readonly string[];
  readonly baseUriDomains?: readonly string[];
}

/** What `defineAdmin` takes beside the generated metadata. */
export interface AdminConfig<T extends AdminTypes = AdminTypes> {
  /** Replace or wrap regions of Admin; applied after `plugins`, so these are outermost. */
  readonly components?: AdminComponents<T>;
  /** Fragments applied in order: each one's `renderDefault` is the plugin before it, or the built-in component. */
  readonly plugins?: readonly AdminPlugin[];
  /** What the Admin MCP App may load, for a host's CSP. */
  readonly mcp?: { readonly csp?: AdminMcpCsp };
}

/** What an Admin entry default-exports and `<MantleAdmin>` renders. */
export interface AdminDefinition {
  readonly meta: AdminMeta;
  /** The components of each slot, nearest the built-in first. */
  readonly layers: AdminLayers;
  readonly mcp?: { readonly csp?: AdminMcpCsp };
}

/**
 * Compose Admin from generated metadata. The result is plain data; it grants and denies nothing: showing, hiding or
 * replacing a region changes no server-side permission.
 */
export function defineAdmin<T extends AdminTypes>(meta: AdminMeta<T>, config: AdminConfig<NoInfer<T>> = {}): AdminDefinition {
  const layers: { [name: string]: SlotComponent<never>[] } = {};
  for (const components of [...(config.plugins ?? []).map(plugin => plugin.components), config.components]) {
    for (const [name, component] of Object.entries(components ?? {})) if (component) (layers[name] ??= []).push(component as SlotComponent<never>);
  }
  return { meta: meta as AdminMeta, layers, ...(config.mcp ? { mcp: config.mcp } : {}) };
}
