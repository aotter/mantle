/**
 * SQLite-shaped implementation detail used by the official SQLite/D1
 * storage preparation path. Portable runtime use cases depend on semantic
 * repositories and `ViewQueryExecutor`, never this SQL surface.
 *
 * The shape stays intentionally close to D1's API. Adapters that reuse the
 * shipped SQLite implementation wrap their native driver to this shape:
 *
 *   - `mantle-cloudflare` wraps `env.DB` (D1) directly (1:1 surface).
 *   - Core tests supply in-memory implementations under `test/fakes/`.
 *
 * PostgreSQL, MongoDB, and application-owned tables implement
 * `MantleStorageAdapter` with semantic ports instead of emulating SQLite.
 * See ADR-0019.
 */
export interface DatabaseDriver {
  /** Build a parameterised statement. Bind values then execute. */
  prepare(sql: string): PreparedStatement;
  /** Execute multiple statements atomically. Adapters guarantee
   *  all-or-nothing semantics — a child-row delete + parent delete
   *  can't half-land. */
  batch(stmts: ReadonlyArray<PreparedStatement>): Promise<readonly BatchResult[]>;
  /** Migration runner used by SQLite storage preparation. */
  readonly migrations: MigrationRunner;
}

/**
 * Parameterised statement. Adapters return their native prepared-
 * statement object cast to this shape, so `bind` reuses native binding
 * and `first` / `all` / `run` map to the driver's typed accessors.
 */
export interface PreparedStatement {
  /** Bind parameters in `?` order. Returns a new statement; original
   *  is unchanged so a single prepared shape can be reused with
   *  different bindings. */
  bind(...params: ReadonlyArray<unknown>): PreparedStatement;
  /** Run and return the first row, typed by `T`. `null` when empty. */
  first<T = Record<string, unknown>>(): Promise<T | null>;
  /** Run and return all rows. */
  all<T = Record<string, unknown>>(): Promise<readonly T[]>;
  /** Run and return only rowcount-style metadata. Use `first` / `all`
   *  for selects; this is for INSERT/UPDATE/DELETE that don't RETURNING. */
  run(): Promise<RunResult>;
}

export interface RunResult {
  readonly success: boolean;
  readonly meta: {
    readonly changes: number;
  };
}

export interface BatchResult {
  readonly success: boolean;
  readonly meta: {
    readonly changes: number;
  };
  readonly results?: readonly Record<string, unknown>[];
}

/**
 * Migration runner contract. The adapter supplies this against its driver;
 * SQLite adapters can reuse `SqliteMigrationRunner`. Selected SQLite
 * preparation calls `runAll(migrations)`.
 * Migration order is the array index — Core supplies the
 * canonical list (see `infrastructure/boot/canonicalMigrations.ts`);
 * adapter just executes.
 *
 * The runner records applied migrations in a `_migrations` table so
 * subsequent boots are idempotent.
 */
export interface MigrationRunner {
  runAll(migrations: ReadonlyArray<Migration>): Promise<void>;
}

export interface Migration {
  /** Stable ordinal — never reused, never renamed. Adapter records
   *  this in `_migrations` for idempotency. */
  readonly id: string;
  /** Free-form description for boot logs. */
  readonly description: string;
  /** SQL DDL / DML to apply. Adapters split on `;` if their driver
   *  doesn't accept multi-statement scripts. */
  readonly sql: string;
}
