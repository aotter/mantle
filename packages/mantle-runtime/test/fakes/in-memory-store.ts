import type { ContentState } from "@aotter/mantle-spec";
import {
  EntryStatusConflict,
  EntryVersionConflict,
  liftLocale,
  type EntryRow,
} from "../../src/domain/model/EntryRow.js";
import type {
  CreateEntryArgs,
  DeleteEntryArgs,
  EntryRepository,
  FindEntryByDataFieldArgs,
  FindEntryByDataFieldsArgs,
  ListEntriesArgs,
  ListEntriesResult,
  TransitionStatusArgs,
  UpdateEntryArgs,
} from "../../src/domain/port/EntryRepository.js";
import {
  decodeEntryCursor,
  encodeEntryCursor,
} from "../../src/infrastructure/persistence/Pagination.js";

/**
 * In-memory `EntryRepository` for content-op + state-machine tests.
 * Zero SQL — just a Map keyed by id. Used wherever a test cares about
 * the use-case verb logic and not SQL execution.
 *
 * Lifts `data.locale` to `EntryRow.locale` at every write so the row
 * shape matches the production `DatabaseEntryRepository` impl.
 */
export class InMemoryEntryRepository implements EntryRepository {
  private rows = new Map<string, EntryRow>();

  async create(args: CreateEntryArgs): Promise<EntryRow> {
    if (this.rows.has(args.id)) throw new Error(`duplicate id: ${args.id}`);
    const data = { ...args.data };
    const row: EntryRow = {
      id: args.id,
      collection: args.collection,
      locale: liftLocale(data),
      status: args.status,
      version: 1,
      data,
      authorId: args.authorId,
      createdAt: args.now,
      updatedAt: args.now,
    };
    this.rows.set(args.id, row);
    return row;
  }

  async get(id: string): Promise<EntryRow | null> {
    return this.rows.get(id) ?? null;
  }

  async update(args: UpdateEntryArgs): Promise<EntryRow> {
    const row = this.rows.get(args.id);
    if (!row) throw new EntryVersionConflict(args.id, args.expectedVersion, -1);
    if (row.version !== args.expectedVersion) {
      throw new EntryVersionConflict(args.id, args.expectedVersion, row.version);
    }
    const data = { ...args.data };
    const next: EntryRow = {
      ...row,
      locale: liftLocale(data),
      data,
      version: row.version + 1,
      updatedAt: args.now,
    };
    this.rows.set(args.id, next);
    return next;
  }

  async delete(args: DeleteEntryArgs): Promise<{ readonly removed: boolean }> {
    const row = this.rows.get(args.id);
    if (!row || row.collection !== args.collection) return { removed: false };
    if (row.version !== args.expectedVersion) {
      throw new EntryVersionConflict(args.id, args.expectedVersion, row.version);
    }
    if (row.status !== args.expectedStatus) {
      throw new EntryStatusConflict(args.id, args.expectedStatus, row.status);
    }
    const removed = this.rows.delete(args.id);
    return { removed };
  }

  async transitionStatus(args: TransitionStatusArgs): Promise<EntryRow> {
    const row = this.rows.get(args.id);
    if (!row) throw new EntryStatusConflict(args.id, args.expectedStatus ?? args.to, args.to);
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
    this.rows.set(args.id, next);
    return next;
  }

  async list(args: ListEntriesArgs): Promise<ListEntriesResult> {
    const limit = args.limit ?? 100;
    const cursor = decodeEntryCursor(args.cursor);
    const filtered: EntryRow[] = [];
    for (const row of this.rows.values()) {
      if (row.collection !== args.collection) continue;
      if (args.status && row.status !== args.status) continue;
      filtered.push(row);
    }
    // Match real DB ordering: updated_at DESC, id DESC.
    filtered.sort((a, b) => b.updatedAt - a.updatedAt || (b.id > a.id ? 1 : b.id < a.id ? -1 : 0));
    const remaining = cursor
      ? filtered.filter((row) =>
          row.updatedAt < cursor[0] || (row.updatedAt === cursor[0] && row.id < cursor[1]))
      : filtered;
    const page = remaining.slice(0, limit);
    const hasMore = remaining.length > limit;
    const last = page[page.length - 1];
    return {
      rows: page,
      nextCursor: hasMore && last ? encodeEntryCursor(last.updatedAt, last.id) : undefined,
    };
  }

  async findByDataField(args: FindEntryByDataFieldArgs): Promise<EntryRow | null> {
    const matches = [...this.rows.values()]
      .filter((row) => row.collection === args.collection)
      .filter((row) => (args.status ? row.status === args.status : true))
      .filter((row) => row.data[args.field] === args.value)
      .sort((a, b) => b.updatedAt - a.updatedAt);
    return matches[0] ?? null;
  }

  async findByDataFields(args: FindEntryByDataFieldsArgs): Promise<EntryRow | null> {
    const fields = Object.entries(args.fields);
    if (fields.length === 0) return null;
    const matches = [...this.rows.values()]
      .filter((row) => row.collection === args.collection)
      .filter((row) => (args.status ? row.status === args.status : true))
      .filter((row) => (args.excludeId ? row.id !== args.excludeId : true))
      .filter((row) => fields.every(([field, value]) => row.data[field] === value))
      .sort((a, b) => b.updatedAt - a.updatedAt);
    return matches[0] ?? null;
  }

  /** Test helper — directly insert/replace rows without going through
   *  the chokepoint. Use sparingly. */
  _seed(row: EntryRow): void {
    this.rows.set(row.id, row);
  }
}
