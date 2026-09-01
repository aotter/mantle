import type { Entry, SchemaManifest } from "@aotter/mantle-spec";
import {
  EntryStatusConflict,
  EntryUniqueConflict,
  EntryVersionConflict,
  clampLimit,
  decodeEntrySortCursor,
  encodeEntrySortCursor,
  liftLocale,
  projectPublicEntry,
  type CreateEntryArgs,
  type DeleteEntryArgs,
  type EntryReader,
  type EntryRepository,
  type EntryRow,
  type FindEntryByDataFieldArgs,
  type FindEntryByDataFieldsArgs,
  type FindManyEntriesByDataFieldArgs,
  type ListEntriesArgs,
  type ListEntriesResult,
  type ReadEntriesByDataFieldInArgs,
  type ReadEntryByDataFieldArgs,
  type ReadEntryBySlugArgs,
  type ReadPublishedEntriesArgs,
  type TransitionStatusArgs,
  type UpdateEntryArgs,
} from "@aotter/mantle-runtime";
import type {
  DBSchema,
  IDBPDatabase,
  IDBPObjectStore,
} from "idb";

export interface MantleIndexedDbSchema extends DBSchema {
  readonly entries: {
    readonly key: string;
    readonly value: EntryRow;
    readonly indexes: {
      readonly byCollection: string;
    };
  };
}

export type MantleIndexedDatabase = IDBPDatabase<MantleIndexedDbSchema>;
type EntryStore = IDBPObjectStore<
  MantleIndexedDbSchema,
  ["entries"],
  "entries",
  "readwrite"
>;

export class IndexedDbEntryRepository implements EntryRepository, EntryReader {
  constructor(
    private readonly database: () => Promise<MantleIndexedDatabase>,
    private readonly schemas: ReadonlyMap<string, SchemaManifest>,
  ) {}

  async create(args: CreateEntryArgs): Promise<EntryRow> {
    const row: EntryRow = {
      id: args.id,
      collection: args.collection,
      locale: liftLocale(args.data),
      status: args.status,
      version: 1,
      data: args.data,
      authorId: args.authorId,
      createdAt: args.now,
      updatedAt: args.now,
    };
    return this.write(async (store) => {
      await this.assertUniqueIndexes(store, args.collection, args.data);
      try {
        await store.add(row);
      } catch (error) {
        if (isIndexedDbConstraintError(error)) {
          throw new EntryUniqueConflict(args.collection, args.data, (error as Error).message);
        }
        throw error;
      }
      return structuredClone(row);
    });
  }

  async get(id: string): Promise<EntryRow | null> {
    return (await (await this.database()).get("entries", id)) ?? null;
  }

  async update(args: UpdateEntryArgs): Promise<EntryRow> {
    return this.write(async (store) => {
      const row = await store.get(args.id);
      if (!row) throw new EntryVersionConflict(args.id, args.expectedVersion, -1);
      if (row.version !== args.expectedVersion) {
        throw new EntryVersionConflict(args.id, args.expectedVersion, row.version);
      }
      await this.assertUniqueIndexes(store, row.collection, args.data, args.id);
      const next: EntryRow = {
        ...row,
        locale: liftLocale(args.data),
        data: args.data,
        version: row.version + 1,
        updatedAt: args.now,
      };
      await store.put(next);
      return structuredClone(next);
    });
  }

  async delete(args: DeleteEntryArgs): Promise<{ readonly removed: boolean }> {
    return this.write(async (store) => {
      const row = await store.get(args.id);
      if (!row || row.collection !== args.collection) return { removed: false };
      if (row.version !== args.expectedVersion) {
        throw new EntryVersionConflict(args.id, args.expectedVersion, row.version);
      }
      if (row.status !== args.expectedStatus) {
        throw new EntryStatusConflict(args.id, args.expectedStatus, row.status);
      }
      await store.delete(args.id);
      return { removed: true };
    });
  }

  async transitionStatus(args: TransitionStatusArgs): Promise<EntryRow> {
    return this.write(async (store) => {
      const row = await store.get(args.id);
      if (!row) {
        throw new EntryStatusConflict(args.id, args.expectedStatus ?? args.to, args.to);
      }
      if (args.expectedVersion !== undefined && row.version !== args.expectedVersion) {
        throw new EntryVersionConflict(args.id, args.expectedVersion, row.version);
      }
      if (args.expectedStatus !== undefined && row.status !== args.expectedStatus) {
        throw new EntryStatusConflict(args.id, args.expectedStatus, row.status);
      }
      const next: EntryRow = {
        ...row,
        status: args.to,
        version: row.version + 1,
        updatedAt: args.now,
      };
      await store.put(next);
      return structuredClone(next);
    });
  }

  async list(args: ListEntriesArgs): Promise<ListEntriesResult> {
    const limit = clampLimit(args.limit);
    const sort = args.sort ?? { field: "updatedAt", direction: "desc" };
    if (!this.sortAvailable(args.collection, sort.field)) {
      throw new Error(`unavailable entry sort field: ${sort.field}`);
    }
    const cursor = decodeEntrySortCursor(args.cursor, sort.field, sort.direction);
    const search = args.search?.toLowerCase();
    const rows = (await this.allRows(args.collection))
      .filter((row) => !args.status || row.status === args.status)
      .filter((row) => !search || row.id.toLowerCase().includes(search) ||
        (args.searchFields ?? []).some((field) =>
          typeof row.data[field] === "string" &&
          row.data[field].toLowerCase().includes(search)))
      .filter((row) => !args.filter || row.data[args.filter.field] === args.filter.value)
      .sort((a, b) => compareRows(a, b, sort.field, sort.direction));
    const candidates = cursor
      ? rows.filter((row) => {
          const order = compareCursor(row, cursor[0], cursor[1], sort.field, sort.direction);
          return args.cursorDirection === "backward" ? order < 0 : order > 0;
        })
      : rows;
    const queried = args.cursorDirection === "backward"
      ? [...candidates].reverse()
      : candidates;
    const hasMore = queried.length > limit;
    const page = queried.slice(0, limit);
    if (args.cursorDirection === "backward") page.reverse();
    const first = page[0];
    const last = page[page.length - 1];
    return {
      rows: page,
      previousCursor: first && (args.cursorDirection === "backward" ? hasMore : cursor !== null)
        ? encodeEntrySortCursor(
            sort.field,
            sort.direction,
            entrySortValue(first, sort.field),
            first.id,
          )
        : undefined,
      nextCursor: last && (args.cursorDirection === "backward" ? cursor !== null : hasMore)
        ? encodeEntrySortCursor(
            sort.field,
            sort.direction,
            entrySortValue(last, sort.field),
            last.id,
          )
        : undefined,
    };
  }

  async findByDataField(args: FindEntryByDataFieldArgs): Promise<EntryRow | null> {
    return this.findByDataFields({
      collection: args.collection,
      status: args.status,
      fields: { [args.field]: args.value },
    });
  }

  async findByDataFields(args: FindEntryByDataFieldsArgs): Promise<EntryRow | null> {
    const fields = Object.entries(args.fields);
    if (fields.length === 0) return null;
    return (await this.allRows(args.collection))
      .filter((row) => !args.status || row.status === args.status)
      .filter((row) => !args.excludeId || row.id !== args.excludeId)
      .filter((row) => fields.every(([field, value]) => row.data[field] === value))
      .sort(newestFirst)[0] ?? null;
  }

  async readById(id: string): Promise<Entry | null> {
    const row = await this.get(id);
    return row ? projectPublicEntry(row) : null;
  }

  async readBySlug(args: ReadEntryBySlugArgs): Promise<Entry | null> {
    return this.readByDataField({ ...args, field: "slug", value: args.slug });
  }

  async readByDataField(args: ReadEntryByDataFieldArgs): Promise<Entry | null> {
    const row = (await this.allRows(args.collection))
      .filter((entry) => !args.status || entry.status === args.status)
      .filter((entry) => matchesLocale(entry, args.locale))
      .filter((entry) => entry.data[args.field] === args.value)
      .sort(newestFirst)[0];
    return row ? projectPublicEntry(row) : null;
  }

  async readByDataFieldIn(args: ReadEntriesByDataFieldInArgs): Promise<readonly Entry[]> {
    const values = new Set(args.values);
    return (await this.allRows(args.collection))
      .filter((entry) => !args.status || entry.status === args.status)
      .filter((entry) => matchesLocale(entry, args.locale))
      .filter((entry) => {
        const value = entry.data[args.field];
        return (typeof value === "string" || typeof value === "number" ||
          typeof value === "boolean") && values.has(value);
      })
      .sort(newestFirst)
      .map(projectPublicEntry);
  }

  async readPublished(args: ReadPublishedEntriesArgs = {}): Promise<readonly Entry[]> {
    const rows = (await this.allRows(args.collection))
      .filter((entry) => entry.status === "published")
      .filter((entry) => matchesLocale(entry, args.locale))
      .sort(newestFirst);
    const limit = typeof args.limit === "number" && Number.isFinite(args.limit) && args.limit > 0
      ? Math.floor(args.limit)
      : rows.length;
    return rows.slice(0, limit).map(projectPublicEntry);
  }

  async findManyByDataField(
    args: FindManyEntriesByDataFieldArgs,
  ): Promise<readonly Entry[]> {
    const limit = Number.isFinite(args.limit) && args.limit > 0
      ? Math.floor(args.limit)
      : 1;
    return (await this.allRows(args.collection))
      .filter((entry) => entry.data[args.field] === args.value)
      .sort(newestFirst)
      .slice(0, limit)
      .map(projectPublicEntry);
  }

  async allRows(collection?: string): Promise<readonly EntryRow[]> {
    const database = await this.database();
    return collection === undefined
      ? database.getAll("entries")
      : database.getAllFromIndex("entries", "byCollection", collection);
  }

  private sortAvailable(collection: string, field: string): boolean {
    if (["id", "status", "updatedAt"].includes(field)) return true;
    const schema = this.schemas.get(collection);
    return !!schema && [
      ...(schema.spec.indexes ?? []),
      ...(schema.spec.uniqueIndexes ?? []),
    ].some((index) => index.includes(field));
  }

  private async assertUniqueIndexes(
    store: EntryStore,
    collection: string,
    data: Record<string, unknown>,
    excludeId?: string,
  ): Promise<void> {
    const schema = this.schemas.get(collection);
    const uniqueIndexes = schema?.spec.uniqueIndexes;
    if (!uniqueIndexes || uniqueIndexes.length === 0) return;

    let rows: readonly EntryRow[] | null = null;
    for (const uniqueIndex of uniqueIndexes) {
      if (uniqueIndex.some((field) => data[field] == null)) continue;
      if (!rows) {
        rows = await store.index("byCollection").getAll(collection);
      }
      const match = rows.find((r) => {
        if (excludeId && r.id === excludeId) return false;
        return uniqueIndex.every((col) => r.data[col] === data[col]);
      });
      if (match) {
        const fields: Record<string, unknown> = {};
        for (const col of uniqueIndex) {
          fields[col] = data[col];
        }
        throw new EntryUniqueConflict(collection, fields);
      }
    }
  }

  private async write<T>(action: (store: EntryStore) => Promise<T>): Promise<T> {
    const tx = (await this.database()).transaction("entries", "readwrite");
    try {
      const result = await action(tx.store);
      await tx.done;
      return result;
    } catch (error) {
      try {
        tx.abort();
      } catch {
        // The browser may already have aborted the failed transaction.
      }
      await tx.done.catch(() => {});
      throw error;
    }
  }
}

function isIndexedDbConstraintError(error: unknown): boolean {
  if (!error) return false;
  if ((error as { name?: string }).name === "ConstraintError") return true;
  if (error instanceof Error && error.message.includes("ConstraintError")) return true;
  return false;
}

function matchesLocale(row: EntryRow, locale: string | null | undefined): boolean {
  if (locale === undefined) return true;
  return locale === null ? row.data.locale == null : row.locale === locale;
}

function newestFirst(a: EntryRow, b: EntryRow): number {
  return b.updatedAt - a.updatedAt || compareText(b.id, a.id);
}

function compareRows(
  a: EntryRow,
  b: EntryRow,
  field: string,
  direction: "asc" | "desc",
): number {
  const av = entrySortValue(a, field);
  const bv = entrySortValue(b, field);
  const order = compareValue(av, bv) || compareText(a.id, b.id);
  return direction === "asc" ? order : -order;
}

function compareCursor(
  row: EntryRow,
  value: string | number,
  id: string,
  field: string,
  direction: "asc" | "desc",
): number {
  const order = compareValue(entrySortValue(row, field), value) || compareText(row.id, id);
  return direction === "asc" ? order : -order;
}

function entrySortValue(row: EntryRow, field: string): string | number {
  if (field === "id") return row.id;
  if (field === "status") return row.status;
  if (field === "updatedAt") return row.updatedAt;
  const value = row.data[field];
  if (typeof value === "boolean") return Number(value);
  if (typeof value !== "string" && typeof value !== "number") {
    throw new Error(`non-scalar sort value for ${field}`);
  }
  return value;
}

function compareValue(a: string | number, b: string | number): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
