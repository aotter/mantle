import type {
  BatchResult,
  DatabaseDriver,
  Migration,
  MigrationRunner,
  PreparedStatement,
  RunResult,
} from "@aotter/mantle-runtime";

/**
 * `DatabaseDriver` impl wrapping Cloudflare's `D1Database` binding.
 *
 * The runtime port shape is intentionally close to D1's API (which is
 * itself close to the SQLite C API), so this wrapper is mostly a
 * type-narrowing pass-through. The notable behaviour is the
 * `D1Migrations` runner: it records applied migrations in a
 * `_mantle_migrations` table so subsequent boots are idempotent.
 *
 * Per ADR-0011 the runtime never imports `D1Database` itself — this
 * file is the only place in the codebase that does.
 */
export class D1DatabaseDriver implements DatabaseDriver {
  readonly migrations: MigrationRunner;

  constructor(private readonly db: D1Database) {
    this.migrations = new D1Migrations(db);
  }

  prepare(sql: string): PreparedStatement {
    return wrap(this.db.prepare(sql));
  }

  async batch(stmts: ReadonlyArray<PreparedStatement>): Promise<readonly BatchResult[]> {
    const native = stmts.map((s) => unwrap(s));
    const results = await this.db.batch(native);
    return results.map((r) => ({
      success: r.success,
      meta: { changes: r.meta.changes ?? 0 },
      results: r.results as ReadonlyArray<Record<string, unknown>> | undefined,
    }));
  }
}

const NATIVE: WeakMap<PreparedStatement, D1PreparedStatement> = new WeakMap();

function wrap(native: D1PreparedStatement): PreparedStatement {
  const stmt: PreparedStatement = {
    bind: (...params) => wrap(native.bind(...params)),
    first: <T = Record<string, unknown>>() => native.first<T>().then((v) => v ?? null),
    all: async <T = Record<string, unknown>>() => {
      const r = await native.all<T>();
      return (r.results ?? []) as readonly T[];
    },
    run: async (): Promise<RunResult> => {
      const r = await native.run();
      return {
        success: r.success,
        meta: { changes: r.meta.changes ?? 0 },
      };
    },
  };
  NATIVE.set(stmt, native);
  return stmt;
}

function unwrap(stmt: PreparedStatement): D1PreparedStatement {
  const native = NATIVE.get(stmt);
  if (!native) {
    throw new Error(
      "D1DatabaseDriver.batch received a statement not produced by this driver. " +
        "Build statements via `db.prepare(...)` on the same DatabaseDriver instance.",
    );
  }
  return native;
}

/**
 * Migration runner. Each migration runs in its own batch — the batch
 * includes the migration's SQL plus the `_mantle_migrations` row insert,
 * so a single migration is all-or-nothing. Migrations across boots are
 * NOT transactional: a worker restart between migration N and N+1
 * leaves N applied, N+1 retried on the next boot. Authors must keep
 * each migration's SQL idempotent on retry (use `IF NOT EXISTS`,
 * `INSERT … ON CONFLICT DO NOTHING`, etc.).
 */
class D1Migrations implements MigrationRunner {
  constructor(private readonly db: D1Database) {}

  async runAll(migrations: ReadonlyArray<Migration>): Promise<void> {
    await this.db
      .prepare(
        `CREATE TABLE IF NOT EXISTS _migrations (id TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)`,
      )
      .run();
    // One-time copy from pre-rename `_mantle_migrations`: idempotent
    // via `INSERT OR IGNORE` + `IF EXISTS`, so re-running on every
    // boot is harmless after the rows have landed. We deliberately
    // DON'T drop the legacy table — codex CX1 showed that any
    // copy-then-drop ordering races between concurrent boots
    // (Worker B's INSERT runs after Worker A's DROP succeeds and
    // crashes with `no such table`). Leaving the legacy table
    // around costs a few KB; eliminating it isn't worth the race
    // class. A standalone op (`mantle migrate drop-legacy`) can
    // remove it later under operator control if desired.
    const legacy = await this.db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='_mantle_migrations'`)
      .first<{ name: string }>();
    if (legacy) {
      await this.db
        .prepare(
          `INSERT OR IGNORE INTO _migrations (id, applied_at) SELECT id, applied_at FROM _mantle_migrations`,
        )
        .run();
    }
    const applied = await this.db
      .prepare(`SELECT id FROM _migrations`)
      .all<{ id: string }>();
    const seen = new Set((applied.results ?? []).map((r) => r.id));
    for (const m of migrations) {
      if (seen.has(m.id)) continue;
      const statements = splitSql(m.sql);
      const ops: D1PreparedStatement[] = statements.map((s) => this.db.prepare(s));
      ops.push(
        this.db
          .prepare(`INSERT INTO _migrations (id, applied_at) VALUES (?, ?)`)
          .bind(m.id, Date.now()),
      );
      try {
        await this.db.batch(ops);
      } catch (error) {
        // Two cold starts can read the same stale `seen` snapshot. The
        // losing batch rolls back atomically; accept it only when the
        // winner has recorded this exact migration in the meantime.
        const winner = await this.db
          .prepare(`SELECT id FROM _migrations WHERE id = ?`)
          .bind(m.id)
          .first<{ id: string }>();
        if (winner?.id !== m.id) throw error;
      }
      seen.add(m.id);
    }
  }
}

/**
 * D1 / SQLite accept multi-statement SQL on the wire, but `.batch`
 * expects each statement separately. Splitting on `;` is correct for
 * our migration corpus (DDL + INSERT seeds, no string literals
 * containing `;`). When that ever stops being true, switch to a
 * lexer-aware split.
 */
function splitSql(sql: string): string[] {
  return sql
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}
