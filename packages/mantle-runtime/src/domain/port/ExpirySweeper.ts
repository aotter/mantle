/** Physical TTL cleanup. Reads already hide expired rows; deletion is opt-in. */
export interface SweepExpiredRequest {
  readonly collection: string;
  readonly limit?: number;
  readonly cursor?: string;
  /** Defaults to preview. Only true removes rows. */
  readonly delete?: boolean;
}

export interface SweepExpiredResult {
  readonly scanned: number;
  readonly removed: number;
  readonly nextCursor?: string;
}

export interface ExpirySweeper {
  sweepExpired(request: SweepExpiredRequest & { readonly limit: number }): Promise<SweepExpiredResult>;
}
