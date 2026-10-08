/**
 * `@aotter/mantle/postgres`: the PostgreSQL dialect's runtime side (ADR-0035). The portable subset on native PostgreSQL types,
 * over any node-postgres-shaped client: `pg` with Cloudflare Hyperdrive on Workers, or `pg` on Bun and Node.
 */
export { postgresStorage, postgresDialect, type PostgresStorageOptions } from "./adapter.js";
export { pgDatabaseDriver, pgPool, type PgAuthPool, type PgClient, type PgConnect } from "./driver.js";
export { requestScoped, type PgSession } from "./session.js";
