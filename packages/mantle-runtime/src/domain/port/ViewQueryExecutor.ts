/** Request values bound to a View query that was prepared for one RuntimePlan. */
export interface ViewQueryOptions {
  readonly params?: Readonly<Record<string, unknown>>;
  readonly page?: number;
  readonly show?: number;
  readonly ctxUserId?: string;
  readonly search?: { readonly term: string; readonly fields: readonly string[] };
  readonly filters?: ReadonlyArray<{ readonly field: string; readonly value: string }>;
}

export interface ViewQueryRequest extends ViewQueryOptions {
  readonly view: string;
}

export interface ViewQueryResult<R = Record<string, unknown>> {
  readonly rows: readonly R[];
  readonly page: number;
  readonly show: number;
  readonly hasMore: boolean;
}

/** Storage-owned execution of already-compiled logical Views. */
export interface ViewQueryExecutor {
  execute<R = Record<string, unknown>>(
    request: ViewQueryRequest,
  ): Promise<ViewQueryResult<R>>;
}
