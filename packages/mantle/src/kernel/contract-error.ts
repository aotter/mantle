export class ContractError extends Error {
  /** HTTP status for codes outside the core set `statusOf` maps. */
  declare readonly status?: number;
  /** Extra wire fields, after `code`, `message` and `path`. */
  declare readonly fields?: Record<string, unknown>;
  constructor(readonly code: string, message: string, readonly path = "", options?: ErrorOptions & { status?: number; fields?: Record<string, unknown> }) {
    super(message, options);
    this.name = "ContractError";
    if (options?.status) this.status = options.status;
    if (options?.fields) this.fields = options.fields;
  }
}

