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
  decodeEntrySortCursor,
  encodeEntrySortCursor,
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
    const sort = args.sort ?? { field: "updatedAt", direction: "desc" };
    const cursor = decodeEntrySortCursor(args.cursor, sort.field, sort.direction);
    const filtered: EntryRow[] = [];
    const search = args.search?.toLowerCase();
    for (const row of this.rows.values()) {
      if (row.collection !== args.collection) continue;
      if (args.status && row.status !== args.status) continue;
      if (search && !row.id.toLowerCase().includes(search) &&
        !(args.searchFields ?? []).some((field) =>
          typeof row.data[field] === "string" &&
          row.data[field].toLowerCase().includes(search))) continue;
      if (args.filter && row.data[args.filter.field] !== args.filter.value) continue;
      filtered.push(row);
    }
    const compare = (a: EntryRow, value: string | number, id: string): number => {
      const av = entrySortValue(a, sort.field);
      const valueOrder = av < value ? -1 : av > value ? 1 : 0;
      const idOrder = a.id < id ? -1 : a.id > id ? 1 : 0;
      const order = valueOrder || idOrder;
      return sort.direction === "asc" ? order : -order;
    };
    filtered.sort((a, b) => compare(a, entrySortValue(b, sort.field), b.id));
    const candidates = cursor
      ? filtered.filter((row) => args.cursorDirection === "backward"
        ? compare(row, cursor[0], cursor[1]) < 0
        : compare(row, cursor[0], cursor[1]) > 0)
      : filtered;
    const queried = args.cursorDirection === "backward" ? [...candidates].reverse() : candidates;
    const hasMore = queried.length > limit;
    const page = queried.slice(0, limit);
    if (args.cursorDirection === "backward") page.reverse();
    const first = page[0];
    const last = page[page.length - 1];
    return {
      rows: page,
      previousCursor: first && (args.cursorDirection === "backward" ? hasMore : cursor !== null)
        ? encodeEntrySortCursor(sort.field, sort.direction, entrySortValue(first, sort.field), first.id)
        : undefined,
      nextCursor: last && (args.cursorDirection === "backward" ? cursor !== null : hasMore)
        ? encodeEntrySortCursor(sort.field, sort.direction, entrySortValue(last, sort.field), last.id)
        : undefined,
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
