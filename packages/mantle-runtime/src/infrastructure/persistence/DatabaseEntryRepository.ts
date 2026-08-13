import {
  schemaIndexedFieldSql,
  type ContentState,
  type Entry,
  type SchemaManifest,
} from "@aotter/mantle-spec";
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
} from "../../domain/port/EntryRepository.js";
import type {
  EntryReader,
  FindManyEntriesByDataFieldArgs,
  ReadEntriesByDataFieldInArgs,
  ReadEntryByDataFieldArgs,
  ReadEntryBySlugArgs,
  ReadPublishedEntriesArgs,
} from "../../domain/port/EntryReader.js";
import type { DatabaseDriver } from "../../domain/port/DatabaseDriver.js";
import { clampLimit } from "../../domain/service/Pagination.js";
import {
  EntryStatusConflict,
  EntryVersionConflict,
  liftLocale,
  projectPublicEntry,
  type EntryRow,
} from "../../domain/model/EntryRow.js";
import {
  decodeEntrySortCursor,
  encodeEntrySortCursor,
  escapeLikeTerm,
} from "./Pagination.js";

/**
 * `EntryRepository` impl backed by `DatabaseDriver`. Adapters that
 * implement `DatabaseDriver` (CF binds D1; future Postgres, Neon,
 * etc.) get this repository for free; the SQL is SQLite-shaped
 * (which Postgres can also execute via Hyperdrive when v0.2 lands).
 *
 * `UPDATE … RETURNING` collapses the post-write SELECT to one round
 * trip on SQLite ≥ 3.35 / Postgres. `delete` uses
 * `DatabaseDriver.batch` because SQLite doesn't enforce FK ON DELETE
 * CASCADE by default and we'd otherwise orphan revisions / approvals
 * when the parent goes.
 *
 * Lifts `data.locale` to `EntryRow.locale` at the rowFromDb boundary
 * — see ADR-0010 + `domain/model/EntryRow.ts`.
 */
export class DatabaseEntryRepository implements EntryRepository, EntryReader {
  constructor(
    private readonly db: DatabaseDriver,
    private readonly schemasByName: ReadonlyMap<string, SchemaManifest> = new Map(),
  ) {}

  async create(args: CreateEntryArgs): Promise<EntryRow> {
    await this.db
      .prepare(
        `INSERT INTO entries (id, collection, status, version, data, author_id, created_at, updated_at)
         VALUES (?, ?, ?, 1, ?, ?, ?, ?)`,
      )
      .bind(
        args.id,
        args.collection,
        args.status,
        JSON.stringify(args.data),
        args.authorId,
        args.now,
        args.now,
      )
      .run();
    return {
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
  }

  async get(id: string): Promise<EntryRow | null> {
    const row = await this.db
      .prepare(
        `SELECT id, collection, status, version, data, author_id, created_at, updated_at
         FROM entries WHERE id = ?`,
      )
      .bind(id)
      .first<EntryDbRow>();
    return row ? rowFromDb(row) : null;
  }

  async update(args: UpdateEntryArgs): Promise<EntryRow> {
    const newVersion = args.expectedVersion + 1;
    const row = await this.db
      .prepare(
        `UPDATE entries SET data = ?, version = ?, updated_at = ?
         WHERE id = ? AND version = ?
         RETURNING id, collection, status, version, data, author_id, created_at, updated_at`,
      )
      .bind(
        JSON.stringify(args.data),
        newVersion,
        args.now,
        args.id,
        args.expectedVersion,
      )
      .first<EntryDbRow>();
    if (!row) throw await this.versionConflict(args.id, args.expectedVersion);
    return rowFromDb(row);
  }

  async delete(args: DeleteEntryArgs): Promise<{ readonly removed: boolean }> {
    const parentMatches =
      `id = ? AND collection = ? AND status = ? AND version = ?`;
    const parentSnapshot = [
      args.id,
      args.collection,
      args.expectedStatus,
      args.expectedVersion,
    ] as const;
    const result = await this.db.batch([
      this.db
        .prepare(
          `DELETE FROM revisions WHERE entry_id = ?
           AND EXISTS (SELECT 1 FROM entries WHERE ${parentMatches})`,
        )
        .bind(args.id, ...parentSnapshot),
      this.db
        .prepare(
          `DELETE FROM approvals WHERE entry_id = ?
           AND EXISTS (SELECT 1 FROM entries WHERE ${parentMatches})`,
        )
        .bind(args.id, ...parentSnapshot),
      this.db
        .prepare(`DELETE FROM entries WHERE ${parentMatches}`)
        .bind(...parentSnapshot),
    ]);
    const last = result[result.length - 1];
    if ((last?.meta.changes ?? 0) > 0) return { removed: true };
    const after = await this.db
      .prepare(`SELECT collection, status, version FROM entries WHERE id = ?`)
      .bind(args.id)
      .first<{ collection: string; status: ContentState; version: number }>();
    if (!after || after.collection !== args.collection) return { removed: false };
    if (after.version !== args.expectedVersion) {
      throw new EntryVersionConflict(args.id, args.expectedVersion, after.version);
    }
    throw new EntryStatusConflict(args.id, args.expectedStatus, after.status);
  }

  async transitionStatus(args: TransitionStatusArgs): Promise<EntryRow> {
    const { expectedStatus, expectedVersion } = args;
    const guards: string[] = [];
    const binds: unknown[] = [args.to, args.now, args.id];
    if (expectedStatus !== undefined) {
      guards.push(" AND status = ?");
      binds.push(expectedStatus);
    }
    if (expectedVersion !== undefined) {
      guards.push(" AND version = ?");
      binds.push(expectedVersion);
    }
    const row = await this.db
      .prepare(
        `UPDATE entries SET status = ?, version = version + 1, updated_at = ?
         WHERE id = ?${guards.join("")}
         RETURNING id, collection, status, version, data, author_id, created_at, updated_at`,
      )
      .bind(...binds)
      .first<EntryDbRow>();
    if (row) return rowFromDb(row);
    // Disambiguate version- vs. status-conflict from a single SELECT —
    // splitting into two SELECTs leaves a TOCTOU window where a third
    // concurrent writer between the two reads can flip which guard
    // appears to have failed.
    const after = await this.db
      .prepare(`SELECT version, status FROM entries WHERE id = ?`)
      .bind(args.id)
      .first<{ version: number; status: string }>();
    if (expectedVersion !== undefined && after && after.version !== expectedVersion) {
      throw new EntryVersionConflict(args.id, expectedVersion, after.version);
    }
    throw new EntryStatusConflict(
      args.id,
      expectedStatus ?? args.to,
      (after?.status as ContentState | undefined) ?? args.to,
    );
  }

  async list(args: ListEntriesArgs): Promise<ListEntriesResult> {
    // Use the shared clamp so direct repo callers (tests, future
    // adapters that bypass the use case) get the same default page
    // size as ListEntriesUseCase — not a silently different 100.
    const limit = clampLimit(args.limit);
    const sort = args.sort ?? { field: "updatedAt", direction: "desc" };
    const schema = this.schemasByName.get(args.collection);
    const sortSql = entrySortSql(schema, sort.field);
    if (!sortSql) throw new Error(`unavailable entry sort field: ${sort.field}`);
    const cursor = decodeEntrySortCursor(args.cursor, sort.field, sort.direction);
    const backward = args.cursorDirection === "backward" && cursor !== null;
    const queryDirection = backward
      ? (sort.direction === "asc" ? "DESC" : "ASC")
      : sort.direction.toUpperCase();
    // Fetch limit+1 to detect a next page without a second query —
    // the extra row never reaches the caller.
    const probe = limit + 1;
    const conditions = ["collection = ?"];
    const binds: unknown[] = [args.collection];
    if (args.status) {
      conditions.push("status = ?");
      binds.push(args.status);
    }
    if (args.search) {
      const term = escapeLikeTerm(args.search);
      const searchConditions = ["id LIKE '%'||?||'%' ESCAPE '\\'"];
      binds.push(term);
      for (const field of args.searchFields ?? []) {
        searchConditions.push("json_extract(data, ?) LIKE '%'||?||'%' ESCAPE '\\'");
        binds.push(jsonPathForTopLevelField(field), term);
      }
      conditions.push(`(${searchConditions.join(" OR ")})`);
    }
    if (args.filter) {
      const compiled = compileDataPredicates(schema, [{
        field: args.filter.field,
        kind: "equal",
        value: args.filter.value,
      }]);
      conditions.push(...compiled.conditions);
      binds.push(...compiled.binds);
    }
    if (cursor) {
      const comparison = backward
        ? (sort.direction === "asc" ? "<" : ">")
        : (sort.direction === "asc" ? ">" : "<");
      conditions.push(`(${sortSql}, id) ${comparison} (?, ?)`);
      binds.push(...cursor);
    }
    binds.push(probe);
    const stmt = this.db
      .prepare(
        `SELECT id, collection, status, version, data, author_id, created_at, updated_at
         FROM entries WHERE ${conditions.join(" AND ")}
         ORDER BY ${sortSql} ${queryDirection}, id ${queryDirection} LIMIT ?`,
      )
      .bind(...binds);
    const rows = await stmt.all<EntryDbRow>();
    const hasMore = rows.length > limit;
    const page = [...(hasMore ? rows.slice(0, limit) : rows)];
    if (backward) page.reverse();
    const first = page[0];
    const last = page[page.length - 1];
    return {
      rows: page.map(rowFromDb),
      previousCursor: first && (backward ? hasMore : cursor !== null)
        ? encodeEntrySortCursor(sort.field, sort.direction, entrySortValueFromDb(first, sort.field), first.id)
        : undefined,
      nextCursor: last && (backward ? cursor !== null : hasMore)
        ? encodeEntrySortCursor(sort.field, sort.direction, entrySortValueFromDb(last, sort.field), last.id)
        : undefined,
    };
  }

  async findByDataField(args: FindEntryByDataFieldArgs): Promise<EntryRow | null> {
    return this.findOneByDataFields({
      collection: args.collection,
      status: args.status,
      fields: { [args.field]: args.value },
    });
  }

  async findByDataFields(args: FindEntryByDataFieldsArgs): Promise<EntryRow | null> {
    return this.findOneByDataFields(args);
  }

  async readById(id: string): Promise<Entry | null> {
    const row = await this.get(id);
    return row ? projectPublicEntry(row) : null;
  }

  async readBySlug(args: ReadEntryBySlugArgs): Promise<Entry | null> {
    return this.readByDataField({
      collection: args.collection,
      field: "slug",
      value: args.slug,
      locale: args.locale,
      status: args.status,
    });
  }

  async readByDataField(args: ReadEntryByDataFieldArgs): Promise<Entry | null> {
    const row = await this.findOneByDataFields({
      collection: args.collection,
      status: args.status,
      fields: { [args.field]: args.value },
      locale: args.locale,
    });
    return row ? projectPublicEntry(row) : null;
  }

  async readByDataFieldIn(
    args: ReadEntriesByDataFieldInArgs,
  ): Promise<readonly Entry[]> {
    const values = [...new Set(args.values)];
    if (values.length === 0) return [];

    const entries: Entry[] = [];
    for (let start = 0; start < values.length; start += ENTRY_READ_BATCH_SIZE) {
      const chunk = values.slice(start, start + ENTRY_READ_BATCH_SIZE);
      const conditions = ["collection = ?"];
      const binds: unknown[] = [args.collection];
      const schema = this.schemasByName.get(args.collection);
      const compiled = compileDataPredicates(schema, [
        { field: args.field, kind: "in", values: chunk },
        ...localePredicates(args.locale),
      ]);
      conditions.push(...compiled.conditions);
      binds.push(...compiled.binds);
      if (args.status) {
        conditions.push("status = ?");
        binds.push(args.status);
      }
      const rows = await this.db
        .prepare(
          `SELECT ${ENTRY_COLUMNS} FROM entries
           WHERE ${conditions.join(" AND ")} ORDER BY updated_at DESC`,
        )
        .bind(...binds)
        .all<EntryDbRow>();
      entries.push(...rows.map(rowFromDb).map(projectPublicEntry));
    }
    entries.sort((a, b) => b.updatedAt - a.updatedAt);
    return entries;
  }

  async readPublished(
    args: ReadPublishedEntriesArgs = {},
  ): Promise<readonly Entry[]> {
    const conditions = ["status = 'published'"];
    const binds: unknown[] = [];
    if (args.locale === null) {
      conditions.push("entry_locale IS NULL");
    } else if (args.locale !== undefined) {
      conditions.push("entry_locale = ?");
      binds.push(args.locale);
    }
    if (args.collection) {
      conditions.push("collection = ?");
      binds.push(args.collection);
    }
    let sql =
      `SELECT ${ENTRY_COLUMNS} FROM entries ` +
      `WHERE ${conditions.join(" AND ")} ORDER BY updated_at DESC`;
    if (
      typeof args.limit === "number" &&
      Number.isFinite(args.limit) &&
      args.limit > 0
    ) {
      sql += ` LIMIT ${Math.floor(args.limit)}`;
    }
    const rows = await this.db.prepare(sql).bind(...binds).all<EntryDbRow>();
    return rows.map(rowFromDb).map(projectPublicEntry);
  }

  async findManyByDataField(
    args: FindManyEntriesByDataFieldArgs,
  ): Promise<readonly Entry[]> {
    const conditions = ["collection = ?"];
    const binds: unknown[] = [args.collection];
    const compiled = compileDataPredicates(
      this.schemasByName.get(args.collection),
      [{ field: args.field, kind: "equal", value: args.value }],
    );
    conditions.push(...compiled.conditions);
    binds.push(...compiled.binds);
    const limit = Number.isFinite(args.limit) && args.limit > 0
      ? Math.floor(args.limit)
      : 1;
    const rows = await this.db
      .prepare(
        `SELECT ${ENTRY_COLUMNS} FROM entries
         WHERE ${conditions.join(" AND ")}
         ORDER BY updated_at DESC, id DESC LIMIT ${limit}`,
      )
      .bind(...binds)
      .all<EntryDbRow>();
    return rows.map(rowFromDb).map(projectPublicEntry);
  }

  private async findOneByDataFields(args: {
    readonly collection: string;
    readonly status?: ContentState;
    readonly fields: Readonly<Record<string, unknown>>;
    readonly locale?: string | null;
    readonly excludeId?: string;
  }): Promise<EntryRow | null> {
    const entries = Object.entries(args.fields);
    if (entries.length === 0) return null;
    const conditions = ["collection = ?"];
    const binds: unknown[] = [args.collection];
    const schema = this.schemasByName.get(args.collection);
    if (args.status) {
      conditions.push("status = ?");
      binds.push(args.status);
    }
    const compiled = compileDataPredicates(schema, [
      ...entries.map(([field, value]) => ({
        field,
        kind: "equal" as const,
        value,
      })),
      ...localePredicates(args.locale),
    ]);
    conditions.push(...compiled.conditions);
    binds.push(...compiled.binds);
    if (args.excludeId) {
      conditions.push("id <> ?");
      binds.push(args.excludeId);
    }
    const row = await this.db
      .prepare(
        `SELECT id, collection, status, version, data, author_id, created_at, updated_at
         FROM entries
         WHERE ${conditions.join(" AND ")}
         ORDER BY updated_at DESC LIMIT 1`,
      )
      .bind(...binds)
      .first<EntryDbRow>();
    return row ? rowFromDb(row) : null;
  }

  private async versionConflict(
    id: string,
    expected: number,
  ): Promise<EntryVersionConflict> {
    const after = await this.db
      .prepare(`SELECT version FROM entries WHERE id = ?`)
      .bind(id)
      .first<{ version: number }>();
    return new EntryVersionConflict(id, expected, after?.version ?? -1);
  }
}

const ENTRY_COLUMNS =
  "id, collection, status, version, data, author_id, created_at, updated_at";

// D1 accepts at most 100 bound parameters. The worst fallback shape uses
// five fixed binds (collection, two JSON paths, locale, status), leaving 95
// values for the parent `IN` predicate.
const ENTRY_READ_BATCH_SIZE = 95;

type DataPredicate =
  | { readonly field: string; readonly kind: "equal"; readonly value: unknown }
  | { readonly field: string; readonly kind: "in"; readonly values: readonly (string | number | boolean)[] }
  | { readonly field: string; readonly kind: "null" };

function localePredicates(locale: string | null | undefined): DataPredicate[] {
  if (locale === undefined) return [];
  return locale === null
    ? [{ field: "locale", kind: "null" }]
    : [{ field: "locale", kind: "equal", value: locale }];
}

function compileDataPredicates(
  schema: SchemaManifest | undefined,
  predicates: readonly DataPredicate[],
): { readonly conditions: string[]; readonly binds: unknown[] } {
  const conditions: string[] = [];
  const binds: unknown[] = [];
  const indexed = usableIndexedFields(schema, predicates);
  for (const predicate of predicates) {
    const generated = schema && indexed.has(predicate.field)
      ? schemaIndexedFieldSql(schema, predicate.field)
      : null;
    const reference = generated ?? "json_extract(data, ?)";
    if (!generated) binds.push(jsonPathForTopLevelField(predicate.field));
    if (predicate.kind === "null") {
      conditions.push(`${reference} IS NULL`);
    } else if (predicate.kind === "in") {
      conditions.push(
        `${reference} IN (${predicate.values.map(() => "?").join(", ")})`,
      );
      binds.push(...predicate.values);
    } else {
      conditions.push(`${reference} = ?`);
      binds.push(predicate.value);
    }
  }
  return { conditions, binds };
}

function usableIndexedFields(
  schema: SchemaManifest | undefined,
  predicates: readonly DataPredicate[],
): ReadonlySet<string> {
  if (!schema) return new Set();
  const byField = new Map(predicates.map((predicate) => [predicate.field, predicate]));
  const usable = new Set<string>();
  const declarations = [
    ...(schema.spec.uniqueIndexes ?? []),
    ...(schema.spec.indexes ?? []),
  ];
  for (const declaration of declarations) {
    for (let index = 0; index < declaration.length; index += 1) {
      const field = declaration[index]!;
      const predicate = byField.get(field);
      if (!predicate) break;
      if (
        index === 0 &&
        (predicate.kind === "null" ||
          (predicate.kind === "equal" && predicate.value === null))
      ) {
        break;
      }
      usable.add(field);
    }
  }
  return usable;
}

interface EntryDbRow {
  readonly id: string;
  readonly collection: string;
  readonly status: string;
  readonly version: number;
  readonly data: string;
  readonly author_id: string | null;
  readonly created_at: number;
  readonly updated_at: number;
}

function entrySortSql(schema: SchemaManifest | undefined, field: string): string | null {
  if (field === "id") return "id";
  if (field === "status") return "status";
  if (field === "updatedAt") return "updated_at";
  return schema ? schemaIndexedFieldSql(schema, field) : null;
}

function entrySortValueFromDb(row: EntryDbRow, field: string): string | number {
  if (field === "id") return row.id;
  if (field === "status") return row.status;
  if (field === "updatedAt") return row.updated_at;
  const value = (JSON.parse(row.data) as Record<string, unknown>)[field];
  if (typeof value === "boolean") return Number(value);
  if (typeof value !== "string" && typeof value !== "number") {
    throw new Error(`non-scalar sort value for ${field}`);
  }
  return value;
}

function rowFromDb(row: EntryDbRow): EntryRow {
  const data = JSON.parse(row.data) as Record<string, unknown>;
  return {
    id: row.id,
    collection: row.collection,
    locale: liftLocale(data),
    status: row.status as ContentState,
    version: row.version,
    data,
    authorId: row.author_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function jsonPathForTopLevelField(field: string): string {
  return `$."${field.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** Public compatibility helper. Without a Schema map it intentionally uses
 * the safe JSON fallback; in-repo callers use `CmsRuntime.entryReader`. */
export async function readEntryBySlug(
  db: DatabaseDriver,
  args: ReadEntryBySlugArgs,
): Promise<Entry | null> {
  return new DatabaseEntryRepository(db).readBySlug(args);
}
