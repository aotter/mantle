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

/** What an Admin entry default-exports and `<MantleAdmin>` renders. */
export interface AdminDefinition {
  readonly meta: AdminMeta;
}

/** Compose Admin from generated metadata. The result is plain data; it grants and denies nothing. */
export function defineAdmin<T extends AdminTypes>(meta: AdminMeta<T>): AdminDefinition {
  return { meta: meta as AdminMeta };
}
