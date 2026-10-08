/** Run with Bun, never Vitest/Node: native drivers against real engines, not mocks. */
import assert from 'node:assert/strict';
import pg from 'pg';
import { Database } from 'bun:sqlite';
import { bunSqliteStorage, bunSqliteDriver } from '../../src/bun/index.ts';
import { runStorageConformance } from '../../src/testing/index.ts';
import * as pgCompile from '../../src/postgres/compile/index.ts';
import { compileSql } from '../../src/spec/index.ts';
import { createMantleAuth } from '../../src/auth/index.ts';
import { postgresStorage, pgDatabaseDriver, pgPool, requestScoped, type PgClient, type PgConnect } from '../../src/postgres/index.ts';
import { query } from '../../src/postgres/driver.ts';

/** OTP sign-in of the bootstrap owner: returns the staff list's first role. */
async function signInOwner(auth: ReturnType<typeof createMantleAuth>, codes: Map<string, string>, email: string) {
  const post = (path: string, body: unknown) => auth.handler(new Request(`http://localhost/api/auth${path}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://localhost', 'x-real-ip': '127.0.0.1' }, body: JSON.stringify(body) }));
  assert.equal((await post('/email-otp/send-verification-otp', { email, type: 'sign-in' })).status, 200);
  for (let i = 0; i < 100 && !codes.has(email); i++) await Bun.sleep(10);
  const login = await post('/sign-in/email-otp', { email, otp: codes.get(email) });
  assert.equal(login.status, 200);
  const request = new Request('http://localhost/admin/api/staff', { headers: { cookie: login.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ') } });
  return (await auth.listUsers(request))[0].role;
}
const otpAuth = (database: unknown, driver: ReturnType<typeof bunSqliteDriver>, codes: Map<string, string>, owner: string) => createMantleAuth({ database: database as never, driver, baseURL: 'http://localhost', secret: crypto.randomUUID() + crypto.randomUUID(), ipAddressHeaders: ['x-real-ip'], methods: [{ kind: 'email-otp', sender: { send: async ({ to, text }) => void codes.set(to, /\b(\d{6})\b/.exec(text)![1]!) } }], bootstrapOwner: { match: 'email', value: owner } });

const sqlite = await runStorageConformance({ create: async () => {
  const db = new Database(':memory:');
  return { storage: bunSqliteStorage(db), driver: bunSqliteDriver(db), cleanup: async () => db.close() };
} });
assert.deepEqual(sqlite.failures, []);
console.log(`Bun SQLite: ${sqlite.checks.length} conformance checks passed`);
{
  // one handle for Better Auth and Mantle, as the generated preset wires it
  const db = new Database(':memory:');
  const driver = bunSqliteDriver(db);
  assert.deepEqual(db.prepare('PRAGMA foreign_keys').all(), [{ foreign_keys: 1 }], 'foreign keys on, as on D1');
  const codes = new Map<string, string>();
  assert.equal(await signInOwner(otpAuth(db, driver, codes, 'owner@sqlite.test'), codes, 'owner@sqlite.test'), 'owner', 'bun:sqlite auth signs in the bootstrap owner');
  // a batch never runs inside another transaction on the handle: it waits, so a rollback there cannot take its write back
  await driver.batch([{ sql: 'CREATE TABLE acked (n integer)' }]);
  db.prepare('BEGIN').all();
  const pending = driver.batch([{ sql: 'INSERT INTO acked VALUES (1)' }]);
  await Bun.sleep(20);
  db.prepare('ROLLBACK').all();
  await pending;
  assert.deepEqual(db.prepare('SELECT n FROM acked').all(), [{ n: 1 }], 'an acknowledged write survives the other transaction');
  db.close();
  console.log('Bun SQLite: auth, foreign keys and transactions on a shared handle passed');
}

const url = process.env.MANTLE_PG_URL;
if (!url) { console.log('Bun PostgreSQL skipped: set MANTLE_PG_URL'); process.exit(0); }
// ADR-0039: node-postgres is the PostgreSQL driver on Bun too. Each engine is a pg.Pool in its own schema, pooled as the generated preset does.
const admin = new pg.Pool({ connectionString: url, max: 1 });
const pools: pg.Pool[] = [];
const fresh = async (max = 10) => {
  const schema = `bun_${crypto.randomUUID().replace(/-/g, '')}`;
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new pg.Pool({ connectionString: url, options: `-c search_path=${schema} -c statement_timeout=10000 -c TimeZone=UTC`, pipeline: true, max });
  pools.push(pool);
  const connect: PgConnect = async () => {
    const client = await pool.connect();
    const listeners: ((e: Error) => void)[] = [];
    let broken = false;
    let released = false;
    const onError = () => { broken = true; };
    client.on('error', onError);
    return {
      pipeline: true,
      query: client.query.bind(client),
      on: (_e: 'error', f: (e: Error) => void) => { listeners.push(f); client.on('error', f); },
      getTransactionStatus: () => client.getTransactionStatus(),
      end: async () => { if (released) return; released = true; for (const f of [onError, ...listeners]) client.removeListener('error', f); client.release(broken || client.getTransactionStatus() !== 'I'); },
    } as unknown as PgClient;
  };
  return { pool, connect, storage: postgresStorage({ connect }), driver: pgDatabaseDriver(connect), cleanup: async () => { await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); } };
};
try {
  const pgReport = await runStorageConformance({ compile: pgCompile, create: fresh });
  assert.deepEqual(pgReport.failures, []);
  console.log(`Bun PostgreSQL (node-postgres): ${pgReport.checks.length} conformance checks passed`);
  const engine = await fresh();
  try {
    const codes = new Map<string, string>();
    const auth = createMantleAuth({ database: pgPool(engine.connect), driver: engine.driver, baseURL: 'http://localhost', secret: crypto.randomUUID() + crypto.randomUUID(), ipAddressHeaders: ['x-real-ip'], methods: [{ kind: 'email-otp', sender: { send: async ({ to, text }) => void codes.set(to, /\b(\d{6})\b/.exec(text)![1]!) } }], bootstrapOwner: { match: 'email', value: 'owner@bun.test' } });
    assert.equal(await signInOwner(auth, codes, 'owner@bun.test'), 'owner', 'node-postgres auth signs in the bootstrap owner under Bun');
    // a request-scoped session holds one pooled connection for the whole request; two requests never share one
    const pid = async (connect: PgConnect) => { const c = await connect(); try { return (await c.query({ text: 'SELECT pg_backend_pid() AS pid, pg_sleep(0.05)' })).rows[0]!.pid; } finally { await c.end(); } };
    const [a, b] = [requestScoped(engine.connect), requestScoped(engine.connect)];
    const same = await a.run(async () => [await pid(a.connect), await pid(a.connect)]);
    assert.equal(same[0], same[1], 'one connection per request');
    const [x, y] = await Promise.all([a.run(() => pid(a.connect)), b.run(() => pid(b.connect))]);
    assert.notEqual(x, y, 'two requests never share a connection');
    // the pooled client is reused, so the wrapper's error listeners must not pile up across requests
    const one = await fresh(1);
    const raw = await one.pool.connect(); raw.release();
    const before = raw.listenerCount('error');
    const scoped = requestScoped(one.connect);
    for (let i = 0; i < 15; i++) await scoped.run(() => pid(scoped.connect));
    assert.equal(raw.listenerCount('error'), before, 'a pooled client keeps no error listeners from finished requests');
    await one.cleanup();
    // a statement past its timeout ends with 57014
    await assert.rejects(query(async () => { const c = await engine.pool.connect(); await c.query('SET statement_timeout = 100'); return { query: c.query.bind(c), end: async () => c.release() } as unknown as PgClient; }, { text: 'SELECT pg_sleep(1)::text AS s' }), (e: { code?: string }) => e.code === '57014');
    console.log('Bun PostgreSQL (node-postgres): auth and request-scoped connections passed');
  } finally { await engine.cleanup(); }
} finally { await Promise.allSettled(pools.map((p) => p.end())); await admin.end(); }
