import type { Database } from "bun:sqlite";
import {
  SqliteMigrationRunner,
  type BatchResult,
  type DatabaseDriver,
  type MigrationRunner,
  type PreparedStatement,
  type RunResult,
} from "@aotter/mantle-runtime";

interface BunStatement {
  get(...params: readonly unknown[]): unknown;
  all(...params: readonly unknown[]): readonly unknown[];
  run(...params: readonly unknown[]): { readonly changes: number | bigint };
}

interface BoundStatement {
  readonly sql: string;
  readonly params: readonly unknown[];
}

/** Adapt a caller-owned `bun:sqlite` handle without owning or closing it. */
export class BunDatabaseDriver implements DatabaseDriver {
  readonly migrations: MigrationRunner;
  private readonly statements = new WeakMap<PreparedStatement, BoundStatement>();

  constructor(private readonly database: Database) {
    this.migrations = new SqliteMigrationRunner(this);
  }

  prepare(sql: string): PreparedStatement {
    return this.wrap(sql, []);
  }

  async batch(statements: ReadonlyArray<PreparedStatement>): Promise<readonly BatchResult[]> {
    const bound = statements.map((statement) => this.unwrap(statement));
    return this.database.transaction(() => bound.map(({ sql, params }) => {
      const result = this.statement(sql).run(...params);
      return { success: true, meta: { changes: Number(result.changes) } };
    }))();
  }

  private wrap(sql: string, params: readonly unknown[]): PreparedStatement {
    const statement: PreparedStatement = {
      bind: (...next) => this.wrap(sql, next),
      first: async <T = Record<string, unknown>>() => this.statement(sql).get(...params) as T | null,
      all: async <T = Record<string, unknown>>() => this.statement(sql).all(...params) as readonly T[],
      run: async (): Promise<RunResult> => {
        const result = this.statement(sql).run(...params);
        return { success: true, meta: { changes: Number(result.changes) } };
      },
    };
    this.statements.set(statement, { sql, params });
    return statement;
  }

  private statement(sql: string): BunStatement {
    return this.database.query(sql) as unknown as BunStatement;
  }

  private unwrap(statement: PreparedStatement): BoundStatement {
    const bound = this.statements.get(statement);
    if (!bound) {
      throw new Error(
        "BunDatabaseDriver.batch accepts only statements prepared by the same driver.",
      );
    }
    return bound;
  }
}
