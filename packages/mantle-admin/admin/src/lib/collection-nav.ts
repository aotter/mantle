import type { Collection, RelatedEntrySection } from "./types";

/** Main Admin Nav / home list: top-level collections plus opt-in standalone children. */
export function isPrimaryNavCollection(
  collection: Pick<Collection, "parent" | "nav">,
): boolean {
  return !collection.parent || collection.nav?.standalone === true;
}

/** Required-ref composition children only. Translation children also set
 *  `parent` via `collectionParentFor`, but they stay on language tabs.
 *  For a related section, match its field so other refs stay inline. */
export function isFoldedFieldChild(
  collection: Pick<Collection, "parent" | "translates">,
  parentName: string,
  childField?: string,
): boolean {
  return collection.parent?.collection === parentName && !collection.translates &&
    (childField === undefined || collection.parent.childField === childField);
}

export function foldedChildCollections(
  collections: readonly Collection[],
  parentName: string,
): Collection[] {
  return collections.filter((collection) => isFoldedFieldChild(collection, parentName));
}

export function hasFoldedChildCollections(
  collections: readonly Collection[],
  parentName: string,
): boolean {
  return foldedChildCollections(collections, parentName).length > 0;
}

export function entryLandingPath(collectionName: string, entryId: string): string {
  return `/admin/c/${encodeURIComponent(collectionName)}/${encodeURIComponent(entryId)}`;
}

export function entryEditPath(collectionName: string, entryId: string): string {
  return `${entryLandingPath(collectionName, entryId)}/edit`;
}

/** The value a folded child's reference field holds for its parent: the parent's value of the referenced field
 *  (`id`, or the unique field the reference names), as the server read it. Never the parent's id in place of
 *  another field: null while the parent has no value, so the child list neither lists nor prefills anything. */
export function foldedChildScopeValue(relationship: Pick<RelatedEntrySection["relationship"], "parentValue">): string | null {
  const value = relationship.parentValue;
  return value === null || value === undefined || value === "" ? null : String(value);
}
