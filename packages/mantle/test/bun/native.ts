/** Run with Bun, never Vitest/Node: native drivers against real engines, not mocks. */
import assert from 'node:assert/strict';
import pg from 'pg';
import { Database } from 'bun:sqlite';
import { bunSqliteStorage, bunSqliteDriver } from '../../src/bun/index.ts';
import { runStorageConformance } from '../../src/testing/index.ts';
import * as pgCompile from '../../src/postgres/compile/index.ts';
import { buildAuth } from '../../src/auth/buildAuth.ts';
import { boot, site, caller, program, runView } from '../../src/testing/harness.ts';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMantleAuth } from '../../src/auth/index.ts';
import { postgresStorage, pgDatabaseDriver, type PgConnect } from '../../src/postgres/index.ts';
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


const sqlite = await runStorageConformance({ create: async () => {
  const db = new Database(':memory:');
  return { storage: bunSqliteStorage(db), driver: bunSqliteDriver(db), cleanup: async () => db.close() };
} });
assert.deepEqual(sqlite.failures, []);
console.log(`Bun SQLite: ${sqlite.checks.length} conformance checks passed`);
{
  const dir = await mkdtemp(join(tmpdir(), 'mantle-native-'));
  const filename = join(dir, 'database.sqlite');
  const db = new Database(filename, { create: true });
  db.exec('PRAGMA journal_mode = WAL');
  const authDb = new Database(filename, { create: true });
  const driver = bunSqliteDriver(db), unsupportedSharedDriver = bunSqliteDriver(authDb);
  try {
    const fixture = site(await boot({ storage: bunSqliteStorage(db), driver }));
    const view = await program('view', "SELECT stock FROM items WHERE id = 'a'");
    const read = () => runView(fixture, view, caller());
    assert.deepEqual((await read()).rows, [{ stock: 5 }]);
    assert.equal(db.inTransaction, false, 'View never starts a transaction');
    const codes = new Map<string, string>();
    const config = { database: authDb, driver, baseURL: 'http://localhost', secret: crypto.randomUUID() + crypto.randomUUID(), ipAddressHeaders: ['x-real-ip'], methods: [{ kind: 'email-otp' as const, sender: { send: async ({ to, text }: {to: string; text: string}) => void codes.set(to, /\b(\d{6})\b/.exec(text)![1]!) } }], bootstrapOwner: { match: 'email' as const, value: 'owner@sqlite.test' } };
    const auth = createMantleAuth(config);
    assert.equal(await signInOwner(auth, codes, 'owner@sqlite.test'), 'owner', 'bootstrap after-commit promotion works through the Store handle');
    const ownerId = String(db.query('SELECT id FROM user WHERE role = \'owner\'').get()!.id);
    const nativeAuth = buildAuth(config);
    const { adapter } = await nativeAuth.$context;
    let entered!: () => void, resume!: () => void;
    const held = new Promise<void>(r => { entered = r; });
    const gate = new Promise<void>(r => { resume = r; });
    const pending = adapter.transaction(async () => {
      assert.equal(authDb.inTransaction, true, 'actual Better Auth adapter holds a native async transaction');
      authDb.query("UPDATE items SET stock = 99 WHERE id = 'a'").run();
      authDb.query("UPDATE user SET role = 'editor' WHERE id = ?1").run(ownerId);
      entered();
      await gate;
    });
    await held;
    try {
      assert.deepEqual((await read()).rows, [{ stock: 5 }], 'separate native Store handle reads committed data during Better Auth transaction');
      assert.equal(db.inTransaction, false);
      assert.equal(await auth.getUserRole(ownerId), 'owner', 'ancillary auth SQL uses Store handle and sees committed role while Better Auth owns a transaction');
      await assert.rejects(unsupportedSharedDriver.all!({ sql: 'SELECT stock FROM items' }), /already in a transaction/);
      await assert.rejects(unsupportedSharedDriver.batch([{ sql: "UPDATE items SET stock = 123 WHERE id = 'a'" }]), /already in a transaction/);
      assert.equal(authDb.query("SELECT stock FROM items WHERE id = 'a'").get()!.stock, 99, 'rejected batch never entered a savepoint or wrote');
    } finally { resume(); }
    await pending;
    assert.equal(await auth.getUserRole(ownerId), 'editor', 'ancillary auth SQL sees the fresh role after commit');
    assert.deepEqual((await read()).rows, [{ stock: 99 }], 'View sees the native committed snapshot afterwards');
    // External writer is a native handle; Mantle reader does no IMMEDIATE/polling and writer failure is surfaced.
    authDb.exec('BEGIN IMMEDIATE');
    try {
      authDb.query("UPDATE items SET stock = 100 WHERE id = 'a'").run();
      assert.deepEqual((await read()).rows, [{ stock: 99 }]);
      await assert.rejects(driver.batch([{ sql: "UPDATE items SET stock = 101 WHERE id = 'a'" }]), /locked|busy/i);
    } finally { authDb.exec('ROLLBACK'); }
    assert.deepEqual((await read()).rows, [{ stock: 99 }]);
    console.log('Bun SQLite: native cached View, real Better Auth async isolation, fail-fast shared handle and WAL writer passed');
  } finally { authDb.close(); db.close(); await rm(dir, {recursive:true, force:true}); }
}

const url = process.env.MANTLE_PG_URL;
if (!url) { console.log('Bun PostgreSQL skipped: set MANTLE_PG_URL'); process.exit(0); }
// ADR-0039: node-postgres is the PostgreSQL driver on Bun too. Each engine is a pg.Pool in its own schema, pooled as the generated preset does.
const admin = new pg.Pool({ connectionString: url, max: 1 });
const pools: pg.Pool[] = [];
const fresh = async (max = 10) => {
  const schema = `bun_${crypto.randomUUID().replace(/-/g, '')}`;
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new pg.Pool({ connectionString: url, options: `-c search_path=${schema} -c statement_timeout=10000 -c TimeZone=UTC`, max });
  pools.push(pool);
  const connect: PgConnect = () => pool.connect();
  return { pool, connect, storage: postgresStorage({ connect }), driver: pgDatabaseDriver(connect), cleanup: async () => { await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); } };
};
try {
  const pgReport = await runStorageConformance({ compile: pgCompile, create: fresh });
  assert.deepEqual(pgReport.failures, []);
  console.log(`Bun PostgreSQL (node-postgres): ${pgReport.checks.length} conformance checks passed`);
  const engine = await fresh();
  try {
    const codes = new Map<string, string>();
    const config = { database: engine.pool, driver: engine.driver, baseURL: 'http://localhost', secret: crypto.randomUUID() + crypto.randomUUID(), ipAddressHeaders: ['x-real-ip'], methods: [{ kind: 'email-otp' as const, sender: { send: async ({ to, text }: {to: string; text: string}) => void codes.set(to, /\b(\d{6})\b/.exec(text)![1]!) } }], bootstrapOwner: { match: 'email' as const, value: 'owner@bun.test' } };
    const auth = createMantleAuth(config);
    assert.equal(await signInOwner(auth, codes, 'owner@bun.test'), 'owner', 'node-postgres auth signs in the bootstrap owner under Bun');
    await engine.driver.batch([{sql: 'CREATE TABLE rollback_check (n int UNIQUE)'}]);
    await assert.rejects(engine.driver.batch([{sql: 'INSERT INTO rollback_check VALUES (1)'}, {sql: 'INSERT INTO rollback_check VALUES (1)'}]), (e: {code?:string}) => e.code === '23505');
    assert.deepEqual(await engine.driver.all!({sql:'SELECT n FROM rollback_check'}), [], 'native failed transaction rolled back');
    const ownerId = String((await engine.pool.query("SELECT id FROM \"user\" WHERE role = 'owner'")).rows[0]!.id);
    const { adapter } = await buildAuth(config).$context;
    for (const rollback of [false, true]) {
      let entered!: () => void, resume!: () => void;
      const held = new Promise<void>(r => { entered = r; });
      const gate = new Promise<void>(r => { resume = r; });
      const pending = adapter.transaction(async trx => {
        await trx.update({ model: 'user', where: [{ field: 'id', value: ownerId }], update: { role: rollback ? 'owner' : 'editor' } });
        entered();
        await gate;
        if (rollback) throw new Error('intentional auth rollback');
      });
      await held;
      try {
        assert.equal(await auth.getUserRole(ownerId), rollback ? 'editor' : 'owner', 'the same official Pool gives ancillary SQL a separate client, hiding uncommitted auth changes');
        if (rollback) await engine.driver.batch([{ sql: 'INSERT INTO rollback_check VALUES (7)' }]);
      } finally { resume(); }
      if (rollback) await assert.rejects(pending, /intentional auth rollback/);
      else await pending;
      assert.equal(await auth.getUserRole(ownerId), 'editor', 'committed role is fresh, and the later auth rollback cannot undo it');
    }
    assert.deepEqual(await engine.driver.all!({ sql: 'SELECT n FROM rollback_check' }), [{ n: 7 }], 'a Store write committed on the same native Pool survives another client\'s auth rollback');
    assert.equal(engine.pool.waitingCount, 0);
    assert.equal(engine.pool.idleCount, engine.pool.totalCount, 'native PoolClient release returns all acquired clients');
    // concurrent acquisitions are the native pool contract, with no Mantle request coordinator
    const [a,b] = await Promise.all([engine.pool.connect(),engine.pool.connect()]);
    assert.notEqual(a.processID, b.processID);
    a.release(); b.release();
    // a statement past its timeout ends with 57014
    await assert.rejects(query(async () => { const c = await engine.pool.connect(); await c.query('SET statement_timeout = 100'); return c; }, { text: 'SELECT pg_sleep(1)::text AS s' }), (e: { code?: string }) => e.code === '57014');
    console.log('Bun PostgreSQL (node-postgres): auth, shared native Pool dirty-read isolation, independent write/rollback and release passed');
  } finally { await engine.cleanup(); }
} finally { await Promise.allSettled(pools.map((p) => p.end())); await admin.end(); }
