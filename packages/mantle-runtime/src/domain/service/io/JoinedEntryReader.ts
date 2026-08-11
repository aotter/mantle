import type { ContentState, Entry, SchemaManifest } from "@aotter/mantle-spec";
import type { EntryReader } from "../../port/EntryReader.js";

/**
 * `joinParentIfTranslation` — when `entry.collection` declares
 * `translates.parent`, fetch the parent and merge its data into the
 * child's data (translation wins on key conflict). Implements
 * ADR-0010's promise that public render paths join translations to
 * their parent on the declared field, so parent-only fields like
 * `posts.coverUrl` reach templates that read `data.coverUrl`.
 *
 * Status filter: parent must be in the same lifecycle bucket as the
 * child (typically "published"). `RequestPublishUseCase` already
 * blocks publishing a translation whose parent isn't published, so at
 * render time `parentStatus: "published"` always finds the parent.
 * Preview omits the filter — a draft translation can preview against
 * its already-published parent.
 */
export async function joinParentIfTranslation(
  reader: EntryReader,
  schemas: ReadonlyMap<string, SchemaManifest>,
  entry: Entry,
  options: { readonly parentStatus?: ContentState } = {},
): Promise<Entry> {
  const schema = schemas.get(entry.collection);
  const translates = schema?.spec.translates;
  if (!translates) return entry;

  const joinValue = entry.data[translates.on];
  if (typeof joinValue !== "string" || joinValue === "") return entry;

  const parent = await reader.readByDataField({
    collection: translates.parent,
    field: translates.on,
    value: joinValue,
    // Parent is non-localized by ADR-0010 contract (CrossSchemaChecker
    // enforces `parent.localized: false` when a child has `translates`).
    locale: null,
    status: options.parentStatus,
  });
  if (!parent) return entry;

  return {
    ...entry,
    data: { ...parent.data, ...entry.data },
  };
}

/**
 * Batch sibling for list paths. Issues one `IN (...)` query for all
 * parent lookups across the list, deduplicating join values — so a
 * 20-locale list keyed off the same parent slug costs 1 D1 read, not
 * 20. Assumes all entries share a single collection (the contract of
 * `RenderListLiveUseCase`); if mixed collections ever land here, fall
 * back path-per-entry would be needed.
 */
export async function joinParentForList(
  reader: EntryReader,
  schemas: ReadonlyMap<string, SchemaManifest>,
  entries: readonly Entry[],
  options: { readonly parentStatus?: ContentState } = {},
): Promise<Entry[]> {
  if (entries.length === 0) return [];

  const probe = schemas.get(entries[0]!.collection);
  const translates = probe?.spec.translates;
  if (!translates) return [...entries];

  const joinValues = new Set<string>();
  for (const entry of entries) {
    const value = entry.data[translates.on];
    if (typeof value === "string" && value !== "") joinValues.add(value);
  }
  if (joinValues.size === 0) return [...entries];

  const parents = await reader.readByDataFieldIn({
    collection: translates.parent,
    field: translates.on,
    values: [...joinValues],
    locale: null,
    status: options.parentStatus,
  });
  // Multiple rows per joinValue are sorted updated_at DESC by the
  // query; first occurrence wins (matches single-entry path which
  // does LIMIT 1).
  const parentByValue = new Map<string, Entry>();
  for (const parent of parents) {
    const key = parent.data[translates.on];
    if (typeof key === "string" && !parentByValue.has(key)) {
      parentByValue.set(key, parent);
    }
  }

  return entries.map((entry) => {
    const value = entry.data[translates.on];
    if (typeof value !== "string") return entry;
    const parent = parentByValue.get(value);
    if (!parent) return entry;
    return {
      ...entry,
      data: { ...parent.data, ...entry.data },
    };
  });
}
