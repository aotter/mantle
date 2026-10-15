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
 * Generated Admin metadata for `defineAdmin`: the admin MCP tool that serves each View and operation, or `null` when
 * none does; the built-in entry has none. The browser reads `/admin/api` and ignores it; inside an MCP host the hooks call the tool. It names Views
 * and operations only, so nothing here grants or denies anything.
 */
export interface AdminMeta<T extends AdminTypes = AdminTypes> {
  readonly views?: { readonly [N in keyof T["views"]]: { readonly tool: string | null } };
  readonly operations?: { readonly [N in keyof T["operations"]]: { readonly tool: string | null } };
}

/** What an Admin entry default-exports and `<MantleAdmin>` renders. */
export interface AdminDefinition {
  readonly meta: AdminMeta;
}

/** Compose Admin from generated metadata. The result is plain data; it grants and denies nothing. */
export function defineAdmin<T extends AdminTypes>(meta: AdminMeta<T>): AdminDefinition {
  return { meta: meta as AdminMeta };
}
