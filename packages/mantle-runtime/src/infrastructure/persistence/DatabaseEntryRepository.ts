import {
  checkSchemaAdminUi,
  type ContentState,
  type Entry,
  type SchemaManifest,
} from "@aotter/mantle-spec";
import type { DatabaseDriver } from "../../domain/port/DatabaseDriver.js";
import type {
  CreateEntryArgs,
  DeleteEntryArgs,
  EntryKey,
  EntryRepository,
  FindEntryByDataFieldArgs,
  FindEntryByDataFieldsArgs,
  ListEntriesArgs,
  ListEntriesResult,
  TransitionStatusArgs,
  UpdateEntryArgs,
} from "../../domain/port/EntryRepository.js";
import type {
  CreationStatistics,
  CreationStatisticsArgs,
  EntryReader,
  FindManyEntriesByDataFieldArgs,
  PublishedEntryPage,
  ReadEntriesByDataFieldInArgs,
  ReadEntryByDataFieldArgs,
  ReadEntryBySlugArgs,
  ReadPublishedEntriesArgs,
  ReadPublishedPageArgs,
} from "../../domain/port/EntryReader.js";
import {
  EntryStatusConflict,
  EntryUniqueConflict,
  EntryVersionConflict,
  liftLocale,
  projectPublicEntry,
  type EntryRow,
} from "../../domain/model/EntryRow.js";
import { clampLimit } from "../../domain/service/Pagination.js";
import {
  decodeEntrySortCursor,
  encodeEntrySortCursor,
  escapeLikeTerm,
  paginatePublishedEntries,
  PUBLISHED_PAGE_DATA_BUDGET,
  publishedPageLimit,
} from "./Pagination.js";
import {
  decodeField,
  encodeField,
  fieldColumn,
  fieldSql,
  isNullableJsonSchema,
  sqliteSchemaTable,
  type SqliteSchemaTable,
} from "../storage/SqliteSchemaTables.js";

/** SQLite/D1 repository where each Schema is one physical table. */
export class DatabaseEntryRepository implements EntryRepository, EntryReader {
  constructor(
    private readonly db: DatabaseDriver,
    private readonly schemasByName: ReadonlyMap<string, SchemaManifest> = new Map(),
  ) {}

  async readCreationStatistics(args: CreationStatisticsArgs): Promise<CreationStatistics> {
    const { from, to, bucketMs } = args;
    if (![from, to, bucketMs].every(Number.isSafeInteger) || from < 0 || to <= from ||
        bucketMs <= 0 || to - from > 20 * 86_400_000 || Math.ceil((to - from) / bucketMs) > 480) {
      throw new RangeError("Statistics require a positive window <= 20 days and <= 480 buckets.");
    }
    const table = this.table(args.collection);
    const filter = checkSchemaAdminUi(table.schema).filter;
    const subtypeField = filter ? requiredFieldSql(table.schema, filter.field) : null;
    const subtype = filter && subtypeField
      ? `CASE WHEN ${subtypeField} IN (${filter.values.map(() => "?").join(", ")}) THEN ${subtypeField} ELSE NULL END`
      : "NULL";
    const total = await this.db.prepare(`SELECT COUNT(*) AS count FROM ${table.table}`)
      .first<{ count: number }>();
    const rows = await this.db.prepare(`SELECT CAST(("_mantle_created_at" - ?) / ? AS INTEGER) AS bucket,
      ${subtype} AS subtype, COUNT(*) AS count FROM ${table.table}
      WHERE "_mantle_created_at" >= ? AND "_mantle_created_at" < ? GROUP BY bucket, subtype`)
      .bind(from, bucketMs, ...(filter ? filter.values : []), from, to)
      .all<{ bucket: number; subtype: string | null; count: number }>();
    return { total: total?.count ?? 0, buckets: rows };
  }

  async create(args: CreateEntryArgs): Promise<EntryRow> {
    const table = this.table(args.collection);
    const columns = ["_mantle_id", "_mantle_status", "_mantle_version", "_mantle_author_id", "_mantle_created_at", "_mantle_updated_at", ...table.fields];
    const values = [args.id, args.status, 1, args.authorId, args.now, args.now, ...this.encodedData(table, args.data)];
    try {
      await this.db.prepare(`INSERT INTO ${table.table} (${columns.map(quote).join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`)
        .bind(...values).run();
    } catch (error) {
      if (isDriverUniqueConstraintError(error)) {
        throw new EntryUniqueConflict(args.collection, args.data, (error as Error).message);
      }
      throw error;
    }
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

  async get(args: EntryKey): Promise<EntryRow | null> {
    const table = this.table(args.collection);
    const row = await this.db.prepare(`SELECT ${table.selectColumns} FROM ${table.table} WHERE "_mantle_id" = ?`)
      .bind(args.id).first<NativeEntryRow>();
    return row ? rowFromDb(table, row) : null;
  }

  async update(args: UpdateEntryArgs): Promise<EntryRow> {
    const table = this.table(args.collection);
    const version = args.expectedVersion + 1;
    const assignments = [...table.fields.map((field) => `${quote(field)} = ?`), '"_mantle_version" = ?', '"_mantle_updated_at" = ?'];
    let row: NativeEntryRow | null = null;
    try {
      row = await this.db.prepare(`UPDATE ${table.table} SET ${assignments.join(", ")}
        WHERE "_mantle_id" = ? AND "_mantle_version" = ? RETURNING ${table.selectColumns}`)
        .bind(...this.encodedData(table, args.data), version, args.now, args.id, args.expectedVersion)
        .first<NativeEntryRow>();
    } catch (error) {
      if (isDriverUniqueConstraintError(error)) {
        throw new EntryUniqueConflict(args.collection, args.data, (error as Error).message);
      }
      throw error;
    }
    if (!row) throw await this.versionConflict(table, args.id, args.expectedVersion);
    return rowFromDb(table, row);
  }

  async delete(args: DeleteEntryArgs): Promise<{ readonly removed: boolean }> {
    const table = this.table(args.collection);
    const result = await this.db.prepare(`DELETE FROM ${table.table} WHERE "_mantle_id" = ? AND "_mantle_status" = ? AND "_mantle_version" = ?`)
      .bind(args.id, args.expectedStatus, args.expectedVersion).run();
    if (result.meta.changes > 0) return { removed: true };
    const after = await this.db.prepare(`SELECT "_mantle_status" AS "status", "_mantle_version" AS "version" FROM ${table.table} WHERE "_mantle_id" = ?`)
      .bind(args.id).first<{ status: ContentState; version: number }>();
    if (!after) return { removed: false };
    if (after.version !== args.expectedVersion) throw new EntryVersionConflict(args.id, args.expectedVersion, after.version);
    throw new EntryStatusConflict(args.id, args.expectedStatus, after.status);
  }

  async transitionStatus(args: TransitionStatusArgs): Promise<EntryRow> {
    const table = this.table(args.collection);
    const conditions = ['"_mantle_id" = ?'];
    const binds: unknown[] = [args.to, args.now, args.id];
    if (args.expectedStatus !== undefined) { conditions.push('"_mantle_status" = ?'); binds.push(args.expectedStatus); }
    if (args.expectedVersion !== undefined) { conditions.push('"_mantle_version" = ?'); binds.push(args.expectedVersion); }
    const row = await this.db.prepare(`UPDATE ${table.table} SET "_mantle_status" = ?, "_mantle_version" = "_mantle_version" + 1, "_mantle_updated_at" = ?
      WHERE ${conditions.join(" AND ")} RETURNING ${table.selectColumns}`).bind(...binds).first<NativeEntryRow>();
    if (row) return rowFromDb(table, row);
    const after = await this.db.prepare(`SELECT "_mantle_status" AS "status", "_mantle_version" AS "version" FROM ${table.table} WHERE "_mantle_id" = ?`)
      .bind(args.id).first<{ status: ContentState; version: number }>();
    if (args.expectedVersion !== undefined && after && after.version !== args.expectedVersion) {
      throw new EntryVersionConflict(args.id, args.expectedVersion, after.version);
    }
    throw new EntryStatusConflict(args.id, args.expectedStatus ?? args.to, after?.status ?? args.to);
  }

  async list(args: ListEntriesArgs): Promise<ListEntriesResult> {
    const table = this.table(args.collection);
    const limit = clampLimit(args.limit);
    const sort = args.sort ?? { field: "updatedAt", direction: "desc" };
    const sortSql = args.sort ? requiredFieldSql(table.schema, sort.field) : '"_mantle_updated_at"';
    const cursor = decodeEntrySortCursor(args.cursor, sort.field, sort.direction);
    const backward = args.cursorDirection === "backward" && cursor !== null;
    const direction = backward ? (sort.direction === "asc" ? "DESC" : "ASC") : sort.direction.toUpperCase();
    const conditions: string[] = [];
    const binds: unknown[] = [];
    if (args.status) { conditions.push('"_mantle_status" = ?'); binds.push(args.status); }
    if (args.search) {
      const term = escapeLikeTerm(args.search);
      const search = ['"_mantle_id" LIKE \'%\'||?||\'%\' ESCAPE \'\\\''];
      binds.push(term);
      for (const field of args.searchFields ?? []) {
        search.push(`${requiredFieldSql(table.schema, field)} LIKE '%'||?||'%' ESCAPE '\\'`);
        binds.push(term);
      }
      conditions.push(`(${search.join(" OR ")})`);
    }
    if (args.filter) { conditions.push(`${requiredFieldSql(table.schema, args.filter.field)} = ?`); binds.push(encodeScalar(table.schema, args.filter.field, args.filter.value)); }
    if (args.scope) { conditions.push(`${requiredFieldSql(table.schema, args.scope.field)} = ?`); binds.push(encodeScalar(table.schema, args.scope.field, args.scope.value)); }
    if (cursor) {
      const comparison = backward ? (sort.direction === "asc" ? "<" : ">") : (sort.direction === "asc" ? ">" : "<");
      conditions.push(`(${sortSql}, "_mantle_id") ${comparison} (?, ?)`);
      binds.push(...cursor);
    }
    binds.push(limit + 1);
    const rows = await this.db.prepare(`SELECT ${table.selectColumns} FROM ${table.table}
      ${conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""}
      ORDER BY ${sortSql} ${direction}, "_mantle_id" ${direction} LIMIT ?`).bind(...binds).all<NativeEntryRow>();
    const hasMore = rows.length > limit;
    const page = [...(hasMore ? rows.slice(0, limit) : rows)];
    if (backward) page.reverse();
    const first = page[0];
    const last = page.at(-1);
    return {
      rows: page.map((row) => rowFromDb(table, row)),
      previousCursor: first && (backward ? hasMore : cursor !== null) ? encodeEntrySortCursor(sort.field, sort.direction, sortValue(first, table.schema, sort.field), first._mantle_id) : undefined,
      nextCursor: last && (backward ? cursor !== null : hasMore) ? encodeEntrySortCursor(sort.field, sort.direction, sortValue(last, table.schema, sort.field), last._mantle_id) : undefined,
    };
  }

  async findByDataField(args: FindEntryByDataFieldArgs): Promise<EntryRow | null> {
    return this.findOne({ ...args, fields: { [args.field]: args.value } });
  }

  async findByDataFields(args: FindEntryByDataFieldsArgs): Promise<EntryRow | null> {
    return this.findOne(args);
  }

  async readById(args: EntryKey): Promise<Entry | null> {
    const row = await this.get(args);
    return row ? projectPublicEntry(row) : null;
  }

  async readBySlug(args: ReadEntryBySlugArgs): Promise<Entry | null> {
    return this.readByDataField({ ...args, field: "slug", value: args.slug });
  }

  async readByDataField(args: ReadEntryByDataFieldArgs): Promise<Entry | null> {
    const row = await this.findOne({ ...args, fields: { [args.field]: args.value } });
    return row ? projectPublicEntry(row) : null;
  }

  async readByDataFieldIn(args: ReadEntriesByDataFieldInArgs): Promise<readonly Entry[]> {
    const values = [...new Set(args.values)];
    if (!values.length) return [];
    const table = this.table(args.collection);
    const field = requiredFieldSql(table.schema, args.field);
    const output: Entry[] = [];
    for (let start = 0; start < values.length; start += 95) {
      const chunk = values.slice(start, start + 95);
      const conditions = [`${field} IN (${chunk.map(() => "?").join(", ")})`];
      const binds: unknown[] = chunk.map((value) => encodeScalar(table.schema, args.field, value));
      this.addReadConditions(table, conditions, binds, args);
      const sql = args.latestPerValue
        ? `SELECT ${table.selectColumns} FROM ${table.table} WHERE "_mantle_id" IN (SELECT "_mantle_id" FROM (
            SELECT "_mantle_id", ROW_NUMBER() OVER (PARTITION BY ${field} ORDER BY "_mantle_updated_at" DESC, "_mantle_id" DESC) AS rank
            FROM ${table.table} WHERE ${conditions.join(" AND ")}) WHERE rank = 1) ORDER BY "_mantle_updated_at" DESC, "_mantle_id" DESC`
        : `SELECT ${table.selectColumns} FROM ${table.table} WHERE ${conditions.join(" AND ")} ORDER BY "_mantle_updated_at" DESC`;
      const rows = await this.db.prepare(sql).bind(...binds).all<NativeEntryRow>();
      output.push(...rows.map((row) => projectPublicEntry(rowFromDb(table, row))));
    }
    return output.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async readPublished(args: ReadPublishedEntriesArgs): Promise<readonly Entry[]> {
    const table = this.table(args.collection);
    const conditions = ['"_mantle_status" = \'published\''];
    const binds: unknown[] = [];
    this.addLocaleCondition(table, conditions, binds, args.locale);
    const limit = typeof args.limit === "number" && Number.isFinite(args.limit) && args.limit > 0 ? ` LIMIT ${Math.floor(args.limit)}` : "";
    const rows = await this.db.prepare(`SELECT ${table.selectColumns} FROM ${table.table} WHERE ${conditions.join(" AND ")} ORDER BY "_mantle_updated_at" DESC${limit}`)
      .bind(...binds).all<NativeEntryRow>();
    return rows.map((row) => projectPublicEntry(rowFromDb(table, row)));
  }

  async readPublishedPage(args: ReadPublishedPageArgs): Promise<PublishedEntryPage> {
    const table = this.table(args.collection);
    const limit = publishedPageLimit(args.limit);
    const fields = args.dataFields
      ? [...new Set([...args.dataFields.filter((field) => table.fields.includes(field)), ...(table.fields.includes("locale") ? ["locale"] : [])])]
      : table.fields;
    const columns = ['"_mantle_id"', '"_mantle_status"', '"_mantle_version"', '"_mantle_author_id"', '"_mantle_created_at"', '"_mantle_updated_at"', ...fields.map(quote)];
    const conditions = ['"_mantle_status" = \'published\''];
    const binds: unknown[] = [];
    if (args.includeUnlocalized && typeof args.locale === "string") {
      const locale = requiredFieldSql(table.schema, "locale");
      conditions.push(`(${locale} = ? OR ${locale} IS NULL)`);
      binds.push(args.locale);
    } else {
      this.addLocaleCondition(table, conditions, binds, args.locale);
    }
    const cursor = decodeEntrySortCursor(args.cursor, "updatedAt", "desc");
    if (cursor) { conditions.push('("_mantle_updated_at", "_mantle_id") < (?, ?)'); binds.push(...cursor); }
    const rowBytes = fields.length
      ? fields.map((field) => `length(CAST(json_quote(${quote(field)}) AS BLOB)) + ${new TextEncoder().encode(field).byteLength + 3}`).join(" + ")
      : "2";
    const rows = await this.db.prepare(`WITH candidates AS (
      SELECT ${columns.join(", ")} FROM ${table.table} WHERE ${conditions.join(" AND ")}
      ORDER BY "_mantle_updated_at" DESC, "_mantle_id" DESC LIMIT ${limit + 1}
    ), budget AS (
      SELECT *, (${rowBytes}) AS "_row_bytes", LEAD("_mantle_id") OVER (ORDER BY "_mantle_updated_at" DESC, "_mantle_id" DESC) AS "_next_id",
        SUM(${rowBytes}) OVER (ORDER BY "_mantle_updated_at" DESC, "_mantle_id" DESC) AS "_data_bytes" FROM candidates
    ) SELECT ${columns.join(", ")}, "_next_id" FROM budget
      WHERE "_data_bytes" = "_row_bytes" OR "_data_bytes" <= ${PUBLISHED_PAGE_DATA_BUDGET}
      ORDER BY "_mantle_updated_at" DESC, "_mantle_id" DESC`)
      .bind(...binds).all<NativeEntryRow & { _next_id: string | null }>();
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      rows: page.map((row) => projectPublicEntry(rowFromDb(table, row, args.dataFields))),
      ...(last?._next_id != null ? { nextCursor: encodeEntrySortCursor("updatedAt", "desc", last._mantle_updated_at, last._mantle_id) } : {}),
    };
  }

  async findManyByDataField(args: FindManyEntriesByDataFieldArgs): Promise<readonly Entry[]> {
    const table = this.table(args.collection);
    const field = requiredFieldSql(table.schema, args.field);
    const limit = Number.isFinite(args.limit) && args.limit > 0 ? Math.floor(args.limit) : 1;
    const rows = await this.db.prepare(`SELECT ${table.selectColumns} FROM ${table.table} WHERE ${field} = ? ORDER BY "_mantle_updated_at" DESC, "_mantle_id" DESC LIMIT ${limit}`)
      .bind(encodeScalar(table.schema, args.field, args.value)).all<NativeEntryRow>();
    return rows.map((row) => projectPublicEntry(rowFromDb(table, row)));
  }

  private table(collection: string): SqliteSchemaTable {
    const schema = this.schemasByName.get(collection);
    if (!schema) throw new Error(`unknown Schema table: ${collection}`);
    return sqliteSchemaTable(schema);
  }

  private encodedData(table: SqliteSchemaTable, data: Record<string, unknown>): unknown[] {
    const properties = table.schema.spec.schema.properties ?? {};
    const unknown = Object.keys(data).find((field) => !Object.hasOwn(properties, field));
    if (unknown) throw new Error(`Schema '${table.schema.metadata.name}' has no field '${unknown}'.`);
    return table.fields.map((field) => encodeField(data[field], properties[field]!));
  }

  private async findOne(args: {
    readonly collection: string;
    readonly status?: ContentState;
    readonly fields: Readonly<Record<string, unknown>>;
    readonly locale?: string | null;
    readonly excludeId?: string;
  }): Promise<EntryRow | null> {
    const table = this.table(args.collection);
    const conditions: string[] = [];
    const binds: unknown[] = [];
    for (const [field, value] of Object.entries(args.fields)) {
      conditions.push(`${requiredFieldSql(table.schema, field)} = ?`);
      binds.push(encodeScalar(table.schema, field, value));
    }
    if (!conditions.length) return null;
    if (args.status) { conditions.push('"_mantle_status" = ?'); binds.push(args.status); }
    this.addLocaleCondition(table, conditions, binds, args.locale);
    if (args.excludeId) { conditions.push('"_mantle_id" <> ?'); binds.push(args.excludeId); }
    const row = await this.db.prepare(`SELECT ${table.selectColumns} FROM ${table.table} WHERE ${conditions.join(" AND ")} ORDER BY "_mantle_updated_at" DESC LIMIT 1`)
      .bind(...binds).first<NativeEntryRow>();
    return row ? rowFromDb(table, row) : null;
  }

  private addReadConditions(
    table: SqliteSchemaTable,
    conditions: string[],
    binds: unknown[],
    args: { readonly status?: ContentState; readonly locale?: string | null },
  ): void {
    if (args.status) { conditions.push('"_mantle_status" = ?'); binds.push(args.status); }
    this.addLocaleCondition(table, conditions, binds, args.locale);
  }

  private addLocaleCondition(table: SqliteSchemaTable, conditions: string[], binds: unknown[], locale: string | null | undefined): void {
    if (locale === undefined) return;
    const field = fieldSql(table.schema, "locale");
    if (!field) {
      if (locale !== null) conditions.push("0 = 1");
      return;
    }
    if (locale === null) conditions.push(`${field} IS NULL`);
    else { conditions.push(`${field} = ?`); binds.push(locale); }
  }

  private async versionConflict(table: SqliteSchemaTable, id: string, expected: number): Promise<EntryVersionConflict> {
    const after = await this.db.prepare(`SELECT "_mantle_version" AS "version" FROM ${table.table} WHERE "_mantle_id" = ?`).bind(id).first<{ version: number }>();
    return new EntryVersionConflict(id, expected, after?.version ?? -1);
  }
}

type NativeEntryRow = Readonly<Record<string, unknown>> & {
  readonly _mantle_id: string;
  readonly _mantle_status: string;
  readonly _mantle_version: number;
  readonly _mantle_author_id: string | null;
  readonly _mantle_created_at: number;
  readonly _mantle_updated_at: number;
};

function rowFromDb(table: SqliteSchemaTable, row: NativeEntryRow, dataFields?: readonly string[]): EntryRow {
  const properties = table.schema.spec.schema.properties ?? {};
  const data: Record<string, unknown> = {};
  let locale: string | undefined;
  for (const field of table.fields) {
    if (!Object.hasOwn(row, field)) continue;
    const value = decodeField(row[field], properties[field]!);
    if (field === "locale" && typeof value === "string") locale = value;
    if ((!dataFields || dataFields.includes(field)) && value !== undefined) data[field] = value;
  }
  for (const field of dataFields ?? []) {
    const property = properties[field];
    if ((!property || isNullableJsonSchema(property)) && !Object.hasOwn(data, field)) data[field] = null;
  }
  return {
    id: row._mantle_id,
    collection: table.schema.metadata.name,
    locale: locale ?? liftLocale(data),
    status: row._mantle_status as ContentState,
    version: row._mantle_version,
    data,
    authorId: row._mantle_author_id,
    createdAt: row._mantle_created_at,
    updatedAt: row._mantle_updated_at,
  };
}

function requiredFieldSql(schema: SchemaManifest, field: string): string {
  const sql = fieldSql(schema, field);
  if (!sql) throw new Error(`Schema '${schema.metadata.name}' has no field '${field}'.`);
  return sql;
}

function encodeScalar(schema: SchemaManifest, field: string, value: unknown): unknown {
  const property = schema.spec.schema.properties?.[field];
  return property ? encodeField(value, property) : value;
}

function sortValue(row: NativeEntryRow, schema: SchemaManifest, field: string): string | number {
  const physical = fieldColumn(schema, field);
  if (!physical) throw new Error(`Schema '${schema.metadata.name}' has no field '${field}'.`);
  const value = row[physical];
  if (typeof value !== "string" && typeof value !== "number") throw new Error(`non-scalar sort value for ${field}`);
  return value;
}

function quote(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

/** Compatibility helper now requires the Schema that owns the table. */
export async function readEntryBySlug(
  db: DatabaseDriver,
  schema: SchemaManifest,
  args: ReadEntryBySlugArgs,
): Promise<Entry | null> {
  return new DatabaseEntryRepository(db, new Map([[schema.metadata.name, schema]])).readBySlug(args);
}

function isDriverUniqueConstraintError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const message = error.message || "";
  return message.includes("UNIQUE constraint failed") || message.includes("unique constraint") ||
    message.includes("duplicate key") || (error as { code?: string }).code === "SQLITE_CONSTRAINT_UNIQUE" ||
    (error as { code?: string }).code === "23505";
}
