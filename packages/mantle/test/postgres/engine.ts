// A fresh PostgreSQL schema per test, on the server MANTLE_PG_URL names (CI runs a postgres service; locally
// `MANTLE_PG_URL=postgres://user:pass@localhost/db pnpm test`). Without it, the PostgreSQL tests are skipped.
import pg from "pg";
import { inject } from "vitest";
import type { PgClient, PgConnect } from "../../src/postgres/index.js";

export const PG_URL = process.env.MANTLE_PG_URL;
/** MANTLE_PG_PIPELINE=1 runs every PostgreSQL test over pipelined clients (one round trip per operation). */
export const PG_PIPELINE = process.env.MANTLE_PG_PIPELINE === "1";

/**
 * `statementTimeoutMs`: the role-level limit a deployment sets (`ALTER ROLE … SET statement_timeout`), here a startup option
 * of each connection; boot refuses a server whose limit is unset or above `postgresStorage`'s.
 */
export async function freshSchema(opts: { url?: string; pipeline?: boolean; statementTimeoutMs?: number } = {}): Promise<{ connect: PgConnect; drop: () => Promise<void>; schema: string }> {
  // The run's prefix (setup.ts) lets the run drop its schemas at the end; outside vitest there is none.
  const run = (() => { try { return inject("pgRun"); } catch { return undefined; } })();
  const schema = `t_${run ? `${run}_` : ""}${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const admin = new pg.Client(PG_URL);
  await admin.connect();
  await admin.query(`CREATE SCHEMA ${schema}`);
  await admin.end();
  const connect: PgConnect = async () => {
    const c = new pg.Client({ connectionString: opts.url ?? PG_URL, options: `-c search_path=${schema} -c statement_timeout=${opts.statementTimeoutMs ?? 10_000} -c TimeZone=UTC`, ...(opts.pipeline ?? PG_PIPELINE ? { pipeline: true } : {}) } as pg.ClientConfig);
    await c.connect();
    return c as unknown as PgClient;
  };
  // Under vitest the run drops its schemas at the end (setup.ts): a drop now would race another file's Better Auth
  // introspection, which reads every schema (#1399).
  const drop = async () => {
    if (run) return;
    const c = new pg.Client(PG_URL);
    await c.connect();
    await c.query(`DROP SCHEMA ${schema} CASCADE`);
    await c.end();
  };
  return { connect, drop, schema };
}
