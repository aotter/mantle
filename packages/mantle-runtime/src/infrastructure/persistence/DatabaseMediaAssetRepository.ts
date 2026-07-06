import type { DatabaseDriver } from "../../domain/port/DatabaseDriver.js";
import type {
  MediaAssetListArgs,
  MediaAssetListResult,
  MediaAssetRepository,
} from "../../domain/port/MediaAssetRepository.js";
import type {
  MediaAsset,
  MediaVariant,
} from "../../domain/port/MediaStorage.js";
import { clampLimit } from "../../domain/service/Pagination.js";

/**
 * `media_assets` row read/write. The variants set + free-form
 * metadata go in as JSON-encoded TEXT — variants is closed-shape so
 * the parse is type-asserted but not validated; the writer is the
 * commit use case which builds the asset from already-verified
 * adapter output.
 *
 * `findManyByIds` issues one `IN (?, ?, ...)` for the whole batch.
 * D1 has a parameter ceiling; the implementation chunks at 100 ids
 * per query and stitches the results. Anyone hitting >100 referenced
 * assets in a single render pass is doing something unusual and the
 * stitching keeps it correct rather than fast — orphan sweep / asset
 * audit consumers (#254) are expected to page through their own
 * windows.
 */
export class DatabaseMediaAssetRepository implements MediaAssetRepository {
  constructor(private readonly db: DatabaseDriver) {}

  async findById(id: string): Promise<MediaAsset | null> {
    const row = await this.db
      .prepare(
        `SELECT id, created_at, owner_id, alt, caption, variants, metadata
         FROM media_assets WHERE id = ?`,
      )
      .bind(id)
      .first<MediaAssetRow>();
    if (!row) return null;
    return rowToAsset(row);
  }

  async findManyByIds(ids: readonly string[]): Promise<ReadonlyMap<string, MediaAsset>> {
    const out = new Map<string, MediaAsset>();
    if (ids.length === 0) return out;
    const deduped = Array.from(new Set(ids));
    for (let i = 0; i < deduped.length; i += CHUNK) {
      const chunk = deduped.slice(i, i + CHUNK);
      const placeholders = chunk.map(() => "?").join(", ");
      const rows = await this.db
        .prepare(
          `SELECT id, created_at, owner_id, alt, caption, variants, metadata
           FROM media_assets WHERE id IN (${placeholders})`,
        )
        .bind(...chunk)
        .all<MediaAssetRow>();
      for (const row of rows) out.set(row.id, rowToAsset(row));
    }
    return out;
  }

  async save(asset: MediaAsset): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO media_assets (id, created_at, owner_id, alt, caption, variants, metadata)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           alt      = excluded.alt,
           caption  = excluded.caption,
           variants = excluded.variants,
           metadata = excluded.metadata`,
      )
      .bind(
        asset.id,
        asset.createdAt,
        null,
        asset.alt ?? null,
        asset.caption ?? null,
        JSON.stringify(asset.variants),
        asset.metadata ? JSON.stringify(asset.metadata) : null,
      )
      .run();
  }

  async delete(id: string): Promise<void> {
    await this.db.prepare(`DELETE FROM media_assets WHERE id = ?`).bind(id).run();
  }

  async list(args: MediaAssetListArgs): Promise<MediaAssetListResult> {
    const limit = clampLimit(args.limit);
    const offset = decodeCursor(args.cursor);
    // Fetch limit+1 to detect a next page without a second query — the
    // extra row never reaches the caller (mirrors EntryRepository.list).
    const probe = limit + 1;
    const conditions: string[] = [];
    const binds: unknown[] = [];
    if (args.search) {
      // LIKE over alt/caption/id — media_assets has no FTS index and no
      // tag/folder column, so this is the whole filter surface. Escape
      // the caller's own wildcards so "50%" stays a literal.
      const term = escapeLikeTerm(args.search);
      conditions.push(
        "(id LIKE '%'||?||'%' ESCAPE '\\' OR alt LIKE '%'||?||'%' ESCAPE '\\' OR caption LIKE '%'||?||'%' ESCAPE '\\')",
      );
      binds.push(term, term, term);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    binds.push(probe, offset);
    const rows = await this.db
      .prepare(
        `SELECT id, created_at, owner_id, alt, caption, variants, metadata
         FROM media_assets ${where}
         ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
      )
      .bind(...binds)
      .all<MediaAssetRow>();
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    return {
      rows: page.map(rowToAsset),
      nextCursor: hasMore ? encodeCursor(offset + limit) : undefined,
    };
  }
}

const CHUNK = 100;

/** Offset-based cursor, prefixed so a future row-value cursor can
 *  coexist by switching on the prefix. Callers treat it as opaque.
 *  Matches `DatabaseEntryRepository`'s scheme. */
const CURSOR_PREFIX = "o:";
function encodeCursor(offset: number): string {
  return `${CURSOR_PREFIX}${offset}`;
}
/** Upper bound on a decoded offset. `Number("1e10")` passes
 *  `Number.isInteger`, so an attacker-supplied cursor could otherwise
 *  drive `OFFSET 10_000_000_000`. Reject anything past a sane cap. */
const MAX_CURSOR_OFFSET = 1_000_000;
function decodeCursor(cursor: string | undefined): number {
  if (!cursor || !cursor.startsWith(CURSOR_PREFIX)) return 0;
  const n = Number(cursor.slice(CURSOR_PREFIX.length));
  return Number.isInteger(n) && n >= 0 && n <= MAX_CURSOR_OFFSET ? n : 0;
}

/** Escape LIKE metacharacters in a user-supplied search term so `%`,
 *  `_`, and `\` are matched literally (ESCAPE '\'). */
function escapeLikeTerm(term: string): string {
  return term.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

interface MediaAssetRow {
  readonly id: string;
  readonly created_at: number;
  readonly owner_id: string | null;
  readonly alt: string | null;
  readonly caption: string | null;
  readonly variants: string;
  readonly metadata: string | null;
}

function rowToAsset(row: MediaAssetRow): MediaAsset {
  const variants = JSON.parse(row.variants) as ReadonlyArray<MediaVariant>;
  const metadata = row.metadata
    ? (JSON.parse(row.metadata) as Readonly<Record<string, string>>)
    : undefined;
  return {
    id: row.id,
    variants,
    alt: row.alt ?? undefined,
    caption: row.caption ?? undefined,
    createdAt: row.created_at,
    metadata,
  };
}
