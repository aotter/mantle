import {
  SqliteMigrationRunner,
  type BatchResult,
  type DatabaseDriver,
  type MigrationRunner,
  type PreparedStatement,
  type RunResult,
} from "@aotter/mantle-runtime";

/**
 * `DatabaseDriver` impl wrapping Cloudflare's `D1Database` binding.
 *
 * The runtime port shape is intentionally close to D1's API (which is
 * itself close to the SQLite C API), so this wrapper is mostly a
 * type-narrowing pass-through. The shared SQLite runner records applied
 * migrations so subsequent boots are idempotent.
 *
 * Per ADR-0011 the runtime never imports `D1Database` itself — this
 * file is the only place in the codebase that does.
 */
export class D1DatabaseDriver implements DatabaseDriver {
  readonly migrations: MigrationRunner;

  constructor(
    private readonly db: D1Database,
    private readonly observe?: D1QueryObserver,
  ) {
    this.migrations = new SqliteMigrationRunner(this);
  }

  prepare(sql: string): PreparedStatement {
    return wrap(this.db.prepare(sql), sql, this.observe);
  }

  async batch(stmts: ReadonlyArray<PreparedStatement>): Promise<readonly BatchResult[]> {
    const wrapped = stmts.map((statement) => unwrap(statement));
    const results = await this.db.batch(wrapped.map(({ native }) => native));
    return results.map((result, index) => {
      notify(this.observe, wrapped[index]?.sql ?? "<batch>", result.meta);
      return {
        success: result.success,
        meta: { changes: result.meta.changes ?? 0 },
        results: result.results as ReadonlyArray<Record<string, unknown>> | undefined,
      };
    });
  }
}

export interface D1QueryMetric {
  readonly sql: string;
  readonly durationMs: number;
  readonly rowsRead: number;
  readonly rowsWritten: number;
}

export type D1QueryObserver = (metric: D1QueryMetric) => void;

interface NativeStatement {
  readonly native: D1PreparedStatement;
  readonly sql: string;
}

const NATIVE: WeakMap<PreparedStatement, NativeStatement> = new WeakMap();

function wrap(
  native: D1PreparedStatement,
  sql: string,
  observe?: D1QueryObserver,
): PreparedStatement {
  const stmt: PreparedStatement = {
    bind: (...params) => wrap(native.bind(...params), sql, observe),
    first: async <T = Record<string, unknown>>() => {
      if (!observe) return native.first<T>().then((value) => value ?? null);
      const result = await native.all<T>();
      notify(observe, sql, result.meta);
      return result.results?.[0] ?? null;
    },
    all: async <T = Record<string, unknown>>() => {
      const r = await native.all<T>();
      notify(observe, sql, r.meta);
      return (r.results ?? []) as readonly T[];
    },
    run: async (): Promise<RunResult> => {
      const r = await native.run();
      notify(observe, sql, r.meta);
      return {
        success: r.success,
        meta: { changes: r.meta.changes ?? 0 },
      };
    },
  };
  NATIVE.set(stmt, { native, sql });
  return stmt;
}

function unwrap(stmt: PreparedStatement): NativeStatement {
  const wrapped = NATIVE.get(stmt);
  if (!wrapped) {
    throw new Error(
      "D1DatabaseDriver.batch received a statement not produced by this driver. " +
        "Build statements via `db.prepare(...)` on the same DatabaseDriver instance.",
    );
  }
  return wrapped;
}

function notify(
  observe: D1QueryObserver | undefined,
  sql: string,
  meta: D1Meta,
): void {
  if (!observe) return;
  try {
    observe({
      sql,
      durationMs: meta.duration ?? 0,
      rowsRead: meta.rows_read ?? 0,
      rowsWritten: meta.rows_written ?? 0,
    });
  } catch {
    // Diagnostics must never turn a successful database operation into a failure.
  }
}
