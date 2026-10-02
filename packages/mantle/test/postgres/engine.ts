// A fresh PostgreSQL schema per test, on the server MANTLE_PG_URL names (CI runs a postgres service; locally
// `MANTLE_PG_URL=postgres://user:pass@localhost/db pnpm test`). Without it, the PostgreSQL tests are skipped.
import pg from "pg";
import type { PgClient, PgConnect } from "../../src/postgres/index.js";

export const PG_URL = process.env.MANTLE_PG_URL;

export async function freshSchema(): Promise<{ connect: PgConnect; drop: () => Promise<void>; schema: string }> {
  const schema = `t_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
  const admin = new pg.Client(PG_URL);
  await admin.connect();
  await admin.query(`CREATE SCHEMA ${schema}`);
  await admin.end();
  const connect: PgConnect = async () => {
    const c = new pg.Client({ connectionString: PG_URL, options: `-c search_path=${schema}` });
    await c.connect();
    return c as unknown as PgClient;
  };
  const drop = async () => {
    const c = new pg.Client(PG_URL);
    await c.connect();
    await c.query(`DROP SCHEMA ${schema} CASCADE`);
    await c.end();
  };
  return { connect, drop, schema };
}
