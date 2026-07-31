import {
  schemaIndexedFieldSql,
  type ContentState,
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
import type { DatabaseDriver } from "../../domain/port/DatabaseDriver.js";
import { clampLimit } from "../../domain/service/Pagination.js";
import {
  EntryStatusConflict,
  EntryVersionConflict,
  liftLocale,
  type EntryRow,
} from "../../domain/model/EntryRow.js";
import { decodeCursor, encodeCursor, escapeLikeTerm } from "./Pagination.js";

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
export class DatabaseEntryRepository implements EntryRepository {
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
    const offset = decodeCursor(args.cursor);
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
      // LIKE over the raw JSON blob is dumb but fine at this scale —
      // there's no FTS index. Escape the caller's own wildcards so a
      // search for "50%" or "a_b" doesn't turn into an unintended
      // pattern.
      const term = escapeLikeTerm(args.search);
      conditions.push("(id LIKE '%'||?||'%' ESCAPE '\\' OR data LIKE '%'||?||'%' ESCAPE '\\')");
      binds.push(term, term);
    }
    binds.push(probe, offset);
    const stmt = this.db
      .prepare(
        `SELECT id, collection, status, version, data, author_id, created_at, updated_at
         FROM entries WHERE ${conditions.join(" AND ")}
         ORDER BY updated_at DESC, id DESC LIMIT ? OFFSET ?`,
      )
      .bind(...binds);
    const rows = await stmt.all<EntryDbRow>();
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    return {
      rows: page.map(rowFromDb),
      nextCursor: hasMore ? encodeCursor(offset + limit) : undefined,
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
    const entries = Object.entries(args.fields);
    if (entries.length === 0) return null;
    const conditions = ["collection = ?"];
    const binds: unknown[] = [args.collection];
    const schema = this.schemasByName.get(args.collection);
    if (args.status) {
      conditions.push("status = ?");
      binds.push(args.status);
    }
    for (const [field, value] of entries) {
      const indexed = schema ? schemaIndexedFieldSql(schema, field) : null;
      if (indexed) {
        conditions.push(`${indexed} = ?`);
        binds.push(value);
      } else {
        conditions.push("json_extract(data, ?) = ?");
        binds.push(jsonPathForTopLevelField(field), value);
      }
    }
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
