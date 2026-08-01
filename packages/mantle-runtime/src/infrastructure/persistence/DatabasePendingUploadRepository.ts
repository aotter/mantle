import type { PendingUploadRecord } from "../../domain/model/PendingUploadRecord.js";
import type { DatabaseDriver } from "../../domain/port/DatabaseDriver.js";
import type { PendingUploadRepository } from "../../domain/port/PendingUploadRepository.js";

/** D1/SQLite-backed pending upload state. Workers KV is eventually consistent
 * and cannot safely bridge an immediate create -> commit sequence. */
export class DatabasePendingUploadRepository implements PendingUploadRepository {
  constructor(private readonly db: DatabaseDriver) {}

  async save(uploadGroupId: string, record: PendingUploadRecord): Promise<void> {
    await this.db.batch([
      this.db
        .prepare(`DELETE FROM pending_media_uploads WHERE expires_at <= ?`)
        .bind(record.createdAt),
      this.db
        .prepare(
          `INSERT INTO pending_media_uploads (id, record, expires_at)
           VALUES (?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             record = excluded.record,
             expires_at = excluded.expires_at`,
        )
        .bind(
          uploadGroupId,
          JSON.stringify(record),
          record.expiresAt,
        ),
    ]);
  }

  async findById(uploadGroupId: string): Promise<PendingUploadRecord | null> {
    const row = await this.db
      .prepare(`SELECT record FROM pending_media_uploads WHERE id = ?`)
      .bind(uploadGroupId)
      .first<{ readonly record: string }>();
    return row ? JSON.parse(row.record) as PendingUploadRecord : null;
  }

  async delete(uploadGroupId: string): Promise<void> {
    await this.db
      .prepare(`DELETE FROM pending_media_uploads WHERE id = ?`)
      .bind(uploadGroupId)
      .run();
  }
}
