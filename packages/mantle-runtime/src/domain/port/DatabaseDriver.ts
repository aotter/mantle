/**
 * `DatabaseDriver` — runtime's adapter-agnostic interface to
 * persistent relational state. The canonical tables (`entries`,
 * `revisions`, `approvals`, `users`, `staff`, `sessions`,
 * `site_config`) live behind this
 * surface; the runtime never sees `D1Database`, `Pool` (postgres),
 * or any concrete driver.
 *
 * The shape is intentionally close to D1's API (which is itself close
 * to the SQLite C API) — that's the smallest common denominator
 * across the adapters we expect to ship. Adapters wrap their native
 * driver to this shape:
 *
 *   - `mantle-cloudflare` wraps `env.DB` (D1) directly (1:1 surface).
 *   - A future Postgres adapter wraps `pg` to the same shape.
 *   - The test harness ships an in-memory impl in `test/fakes/`.
 *
 * See ADR-0011 § DatabaseDriver for the rationale (and the alternatives
 * — mega-port, function-injection, plugin packages — that were
 * rejected). Renamed from `DatabasePort` per the clean-architecture
 * naming convention (no `Port` suffix; ports are discoverable by
 * package alone).
 */
export interface DatabaseDriver {
  /** Build a parameterised statement. Bind values then execute. */
  prepare(sql: string): PreparedStatement;
  /** Execute multiple statements atomically. Adapters guarantee
   *  all-or-nothing semantics — a child-row delete + parent delete
   *  can't half-land. */
  batch(stmts: ReadonlyArray<PreparedStatement>): Promise<readonly BatchResult[]>;
  /** Migration runner — the runtime's `bootInit` invokes
   *  `migrations.runAll()` once per isolate. Adapters supply the
   *  storage; the runtime supplies the canonical migration list. */
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
 * Migration runner contract. The adapter implements this against its
 * driver; the runtime calls `runAll(migrations)` once per isolate at
 * boot. Migration order is the array index — runtime supplies the
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
