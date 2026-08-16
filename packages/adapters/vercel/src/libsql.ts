import type {
  Client,
  InArgs,
  InStatement,
  ResultSet,
} from "@libsql/client";
import {
  SqliteMigrationRunner,
  type BatchResult,
  type DatabaseDriver,
  type MigrationRunner,
  type PreparedStatement,
  type RunResult,
} from "@aotter/mantle-runtime";

interface BoundStatement {
  readonly sql: string;
  readonly args: InArgs;
}

/** Adapt an application-owned remote libSQL/Turso client without closing it. */
export class LibsqlDatabaseDriver implements DatabaseDriver {
  readonly migrations: MigrationRunner;
  private readonly statements = new WeakMap<PreparedStatement, BoundStatement>();

  constructor(private readonly client: Client) {
    this.migrations = new SqliteMigrationRunner(this);
  }

  prepare(sql: string): PreparedStatement {
    return this.wrap(sql, []);
  }

  async batch(statements: ReadonlyArray<PreparedStatement>): Promise<readonly BatchResult[]> {
    const results = await this.client.batch(
      statements.map((statement) => this.unwrap(statement)),
      "write",
    );
    return results.map(toBatchResult);
  }

  private wrap(sql: string, args: readonly unknown[]): PreparedStatement {
    const bound = { sql, args: args as InArgs };
    const statement: PreparedStatement = {
      bind: (...next) => this.wrap(sql, next),
      first: async <T = Record<string, unknown>>() => {
        const result = await this.client.execute(bound);
        return result.rows[0] as T | undefined ?? null;
      },
      all: async <T = Record<string, unknown>>() => {
        const result = await this.client.execute(bound);
        return result.rows as unknown as readonly T[];
      },
      run: async (): Promise<RunResult> => toRunResult(await this.client.execute(bound)),
    };
    this.statements.set(statement, bound);
    return statement;
  }

  private unwrap(statement: PreparedStatement): InStatement {
    const bound = this.statements.get(statement);
    if (!bound) {
      throw new Error(
        "LibsqlDatabaseDriver.batch accepts only statements prepared by the same driver.",
      );
    }
    return bound;
  }
}

function toRunResult(result: ResultSet): RunResult {
  return { success: true, meta: { changes: result.rowsAffected } };
}

function toBatchResult(result: ResultSet): BatchResult {
  return {
    success: true,
    meta: { changes: result.rowsAffected },
    results: result.rows as unknown as readonly Record<string, unknown>[],
  };
}
