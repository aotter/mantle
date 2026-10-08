// Global setup for the PostgreSQL tests: every test schema of one run shares a prefix, and the run drops them all at
// the end. Dropping a schema while another file runs Better Auth's migration introspection (kysely reads the catalog
// across all schemas) fails that introspection with `schema "t_…" does not exist` (#1399), so nothing drops mid-run.
import pg from "pg";
import type { TestProject } from "vitest/node";

declare module "vitest" {
  interface ProvidedContext { pgRun: string }
}

export default function setup(project: TestProject): (() => Promise<void>) | void {
  const run = crypto.randomUUID().replace(/-/g, "").slice(0, 6);
  project.provide("pgRun", run);
  const url = process.env.MANTLE_PG_URL;
  if (!url) return;
  return async () => {
    const c = new pg.Client(url);
    await c.connect();
    try {
      const { rows } = await c.query<{ s: string }>("SELECT nspname AS s FROM pg_namespace WHERE nspname LIKE $1", [`t\\_${run}\\_%`]);
      for (const { s } of rows) await c.query(`DROP SCHEMA ${s} CASCADE`);
    } finally { await c.end(); }
  };
}
