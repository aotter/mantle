import type { ContentState, Entry } from "@aotter/mantle-spec";

export type EntryDataScalar = string | number | boolean;

export interface ReadEntryBySlugArgs {
  readonly collection: string;
  readonly slug: string;
  /** string = exact locale, null = missing/JSON null, omitted = any locale. */
  readonly locale?: string | null;
  readonly status?: ContentState;
}

export interface ReadEntryByDataFieldArgs {
  readonly collection: string;
  readonly field: string;
  readonly value: EntryDataScalar;
  readonly locale?: string | null;
  readonly status?: ContentState;
}

export interface ReadEntriesByDataFieldInArgs {
  readonly collection: string;
  readonly field: string;
  readonly values: readonly EntryDataScalar[];
  readonly locale?: string | null;
  readonly status?: ContentState;
}

export interface ReadPublishedEntriesArgs {
  readonly locale?: string | null;
  readonly collection?: string;
  readonly limit?: number;
}

export interface FindManyEntriesByDataFieldArgs {
  readonly collection: string;
  readonly field: string;
  readonly value: EntryDataScalar;
  readonly limit: number;
}

/**
 * Semantic read surface for render and adapter queries. Unlike
 * `EntryRepository`, this port is not lifecycle-decorated: reads do not fire
 * mutation hooks. Public results are projected to spec `Entry`, so persistence
 * fields such as `authorId` cannot leak into templates or public helpers.
 */
export interface EntryReader {
  readById(id: string): Promise<Entry | null>;
  readBySlug(args: ReadEntryBySlugArgs): Promise<Entry | null>;
  readByDataField(args: ReadEntryByDataFieldArgs): Promise<Entry | null>;
  readByDataFieldIn(args: ReadEntriesByDataFieldInArgs): Promise<readonly Entry[]>;
  readPublished(args?: ReadPublishedEntriesArgs): Promise<readonly Entry[]>;
  findManyByDataField(args: FindManyEntriesByDataFieldArgs): Promise<readonly Entry[]>;
}
