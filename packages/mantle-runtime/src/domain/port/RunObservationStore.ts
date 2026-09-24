/** Safe run facts. The host owns persistence and retention. */
export interface RunObservation {
  readonly scheduleId: string;
  readonly runId: string;
  readonly attempt: number;
  readonly scheduledAt: number;
  readonly startedAt: number;
  readonly finishedAt: number | null;
  readonly status: "started" | "succeeded" | "failed";
  readonly durationMs: number | null;
  readonly errorSummary: string | null;
  readonly counts: { readonly scanned?: number; readonly removed?: number } | null;
}

export interface RunObservationStore {
  start(input: Pick<RunObservation, "scheduleId" | "runId" | "scheduledAt" | "startedAt">): Promise<number>;
  finish(input: Pick<RunObservation, "runId" | "attempt" | "errorSummary" | "counts"> & {
    readonly finishedAt: number;
    readonly status: "succeeded" | "failed";
  }): Promise<void>;
  recent(limit: number): Promise<readonly RunObservation[]>;
  latestBySchedule(): Promise<readonly RunObservation[]>;
}
