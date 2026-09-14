import type { Collection } from "./types";

/** Main Admin Nav / home list: top-level collections plus opt-in standalone children. */
export function isPrimaryNavCollection(
  collection: Pick<Collection, "parent" | "nav">,
): boolean {
  return !collection.parent || collection.nav?.standalone === true;
}

/** Required-ref composition children only. Translation children also set
 *  `parent` via `collectionParentFor`, but they stay on language tabs. */
export function isFoldedFieldChild(
  collection: Pick<Collection, "parent" | "translates">,
  parentName: string,
): boolean {
  return collection.parent?.collection === parentName && !collection.translates;
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
