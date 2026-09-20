import type { ContentState, Entry } from "@aotter/mantle-spec";
import type { EntryKey } from "./EntryRepository.js";

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
  /** Return at most the newest matching row per value (translation list joins). */
  readonly latestPerValue?: boolean;
  readonly locale?: string | null;
  readonly status?: ContentState;
}

export interface ReadPublishedEntriesArgs {
  readonly locale?: string | null;
  readonly collection: string;
  readonly limit?: number;
}

export interface ReadPublishedPageArgs extends ReadPublishedEntriesArgs {
  /** Merge the exact locale with non-localized entries in the same ordered page. */
  readonly includeUnlocalized?: boolean;
  /** Opaque forward cursor in updatedAt DESC, id DESC order. */
  readonly cursor?: string;
  /** Select top-level data keys; omitted returns complete data. Missing keys become null. */
  readonly dataFields?: readonly string[];
}

export interface PublishedEntryPage {
  readonly rows: readonly Entry[];
  readonly nextCursor?: string;
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
export interface CreationStatisticsArgs {
  readonly collection: string;
  readonly from: number;
  readonly to: number;
  readonly bucketMs: number;
}

/** Current retained rows, all statuses; not a historical inventory/event log. */
export interface CreationStatistics {
  readonly total: number;
  readonly buckets: readonly {
    readonly bucket: number;
    readonly subtype: string | null;
    readonly count: number;
  }[];
}

export interface EntryReader {
  /** Optional native aggregation; absence must not trigger a full entry scan in callers. */
  readCreationStatistics?(args: CreationStatisticsArgs): Promise<CreationStatistics>;
  readById(args: EntryKey): Promise<Entry | null>;
  readBySlug(args: ReadEntryBySlugArgs): Promise<Entry | null>;
  readByDataField(args: ReadEntryByDataFieldArgs): Promise<Entry | null>;
  readByDataFieldIn(args: ReadEntriesByDataFieldInArgs): Promise<readonly Entry[]>;
  readPublished(args: ReadPublishedEntriesArgs): Promise<readonly Entry[]>;
  /** At most 2,000 rows and 1 MiB of data JSON per page (default 50 rows).
   * One oversized first entry is returned alone so iteration always advances. */
  readPublishedPage(args: ReadPublishedPageArgs): Promise<PublishedEntryPage>;
  findManyByDataField(args: FindManyEntriesByDataFieldArgs): Promise<readonly Entry[]>;
}
