import type { DatabaseDriver } from "../../domain/port/DatabaseDriver.js";
import type {
  ListedMediaAsset,
  ListMediaAssetsArgs,
  ListMediaAssetsResult,
  MediaAssetRepository,
  UpdateMediaAssetValues,
} from "../../domain/port/MediaAssetRepository.js";
import type {
  MediaAsset,
  MediaVariant,
} from "../../domain/port/MediaStorage.js";

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

  async list(args: ListMediaAssetsArgs): Promise<ListMediaAssetsResult> {
    const limit = clampLimit(args.limit);
    const cursor = decodeCursor(args.cursor);
    const search = args.search?.trim();
    const clauses: string[] = [];
    const params: unknown[] = [];

    if (search) {
      const term = `%${escapeLike(search)}%`;
      clauses.push(
        `(id LIKE ? ESCAPE '\\' OR alt LIKE ? ESCAPE '\\' OR caption LIKE ? ESCAPE '\\')`,
      );
      params.push(term, term, term);
    }
    if (cursor) {
      clauses.push(`(created_at < ? OR (created_at = ? AND id < ?))`);
      params.push(cursor.createdAt, cursor.createdAt, cursor.id);
    }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = await this.db
      .prepare(
        `SELECT id, created_at, owner_id, alt, caption, variants, metadata
         FROM media_assets
         ${where}
         ORDER BY created_at DESC, id DESC
         LIMIT ?`,
      )
      .bind(...params, limit + 1)
      .all<MediaAssetRow>();

    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      items: page.map(rowToListedAsset),
      nextCursor: rows.length > limit && last ? encodeCursor(last.created_at, last.id) : undefined,
    };
  }

  async update(id: string, values: UpdateMediaAssetValues): Promise<MediaAsset | null> {
    const existing = await this.findById(id);
    if (!existing) return null;
    await this.save({
      ...existing,
      alt: values.alt ?? existing.alt,
      caption: values.caption ?? existing.caption,
    });
    return this.findById(id);
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
}

const CHUNK = 100;

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
  return rowToListedAsset(row);
}

function rowToListedAsset(row: MediaAssetRow): ListedMediaAsset {
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
    ownerId: row.owner_id ?? undefined,
  };
}

function clampLimit(limit: number): number {
  return Number.isFinite(limit) ? Math.max(1, Math.min(Math.trunc(limit), 100)) : 30;
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

function encodeCursor(createdAt: number, id: string): string {
  return `${createdAt}:${encodeURIComponent(id)}`;
}

function decodeCursor(value: string | undefined): { createdAt: number; id: string } | null {
  if (!value) return null;
  const [rawCreatedAt, rawId] = value.split(":", 2);
  const createdAt = Number.parseInt(rawCreatedAt ?? "", 10);
  if (!Number.isFinite(createdAt) || !rawId) return null;
  return { createdAt, id: decodeURIComponent(rawId) };
}
