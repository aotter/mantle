/**
 * Generated Admin metadata for `defineAdmin`. The built-in default entry passes an empty object: Admin then reads
 * collections, Views and operations at runtime from the caller-authorized `/admin/api` routes, as it always has.
 */
export type AdminMeta = Readonly<Record<string, unknown>>;

/** What an Admin entry default-exports and `<MantleAdmin>` renders. */
export interface AdminDefinition {
  readonly meta: AdminMeta;
}

/** Compose Admin from generated metadata. The result is plain data; it grants and denies nothing. */
export function defineAdmin(meta: AdminMeta): AdminDefinition {
  return { meta };
}
