import type { DatabaseDriver } from "../../domain/port/DatabaseDriver.js";
import type { RunObservation, RunObservationStore } from "../../domain/port/RunObservationStore.js";

const RETENTION_MS = 30 * 86_400_000;
type StoredRunRow = Omit<RunObservation, "durationMs" | "counts"> & { counts: string | null };

/** SQLite implementation selected by a host; Core consumers see only the semantic port. */
export class DatabaseRunObservationStore implements RunObservationStore {
  private lastPruneAt = 0;
  constructor(private readonly db: DatabaseDriver, private readonly now: () => number = Date.now) {}

  async start(input: Pick<RunObservation, "scheduleId" | "runId" | "scheduledAt" | "startedAt">): Promise<number> {
    if (this.now() - this.lastPruneAt >= 86_400_000) {
      try {
        await this.db.prepare("DELETE FROM _mantle_schedule_runs WHERE started_at < ?")
          .bind(this.now() - RETENTION_MS).run();
        this.lastPruneAt = this.now();
      } catch { /* Retention maintenance must not prevent a scheduled Procedure. */ }
    }
    const row = await this.db.prepare(`INSERT INTO _mantle_schedule_runs
      (run_id, attempt, schedule_id, scheduled_at, started_at, status)
      SELECT ?, COALESCE(MAX(attempt), 0) + 1, ?, ?, ?, 'started'
      FROM _mantle_schedule_runs WHERE run_id = ? RETURNING attempt`)
      .bind(input.runId, input.scheduleId, input.scheduledAt, input.startedAt, input.runId)
      .first<{ attempt: number }>();
    if (!row) throw new Error("Scheduled run observation was not started.");
    return row.attempt;
  }

  async finish(input: Parameters<RunObservationStore["finish"]>[0]): Promise<void> {
    const result = await this.db.prepare(`UPDATE _mantle_schedule_runs
      SET finished_at = ?, status = ?, error_summary = ?, counts = ?
      WHERE run_id = ? AND attempt = ? AND status = 'started'`)
      .bind(input.finishedAt, input.status, input.errorSummary,
        input.counts ? JSON.stringify(input.counts) : null, input.runId, input.attempt).run();
    if (result.meta.changes !== 1) throw new Error("Scheduled run observation was not finished.");
  }

  async recent(limit: number): Promise<readonly RunObservation[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new RangeError("Run observation limit must be 1–50.");
    const rows = await this.db.prepare(`SELECT schedule_id AS scheduleId, run_id AS runId, attempt,
      scheduled_at AS scheduledAt, started_at AS startedAt, finished_at AS finishedAt,
      status, error_summary AS errorSummary, counts
      FROM _mantle_schedule_runs WHERE started_at >= ?
      ORDER BY started_at DESC, attempt DESC LIMIT ?`)
      .bind(this.now() - RETENTION_MS, limit).all<StoredRunRow>();
    return rows.map(toRunObservation);
  }

  async latestBySchedule(): Promise<readonly RunObservation[]> {
    const rows = await this.db.prepare(`SELECT scheduleId, runId, attempt, scheduledAt, startedAt,
      finishedAt, status, errorSummary, counts FROM (
        SELECT schedule_id AS scheduleId, run_id AS runId, attempt,
          scheduled_at AS scheduledAt, started_at AS startedAt, finished_at AS finishedAt,
          status, error_summary AS errorSummary, counts,
          ROW_NUMBER() OVER (PARTITION BY schedule_id ORDER BY started_at DESC, attempt DESC) AS rank
        FROM _mantle_schedule_runs WHERE started_at >= ?
      ) WHERE rank = 1 ORDER BY scheduleId`)
      .bind(this.now() - RETENTION_MS).all<StoredRunRow>();
    return rows.map(toRunObservation);
  }
}

function toRunObservation(row: StoredRunRow): RunObservation {
  return { ...row,
    durationMs: row.finishedAt === null ? null : Math.max(0, row.finishedAt - row.startedAt),
    counts: row.counts ? JSON.parse(row.counts) as RunObservation["counts"] : null,
  };
}
