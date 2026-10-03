/** Run with Bun, never Vitest/Node: native drivers against real engines, not mocks. */
import assert from 'node:assert/strict';
import { SQL } from 'bun';
import { Database } from 'bun:sqlite';
import { bunPgConnect, bunPostgresStorage, bunDatabaseDriver, bunAuthDatabase, bunSqliteStorage, bunSqliteDriver } from '../../src/bun/index.ts';
import { runStorageConformance } from '../../src/testing/index.ts';
import * as pgCompile from '../../src/postgres/compile/index.ts';
import { compileSql } from '../../src/spec/index.ts';
import { createMantleAuth } from '../../src/auth/index.ts';

const sqlite = await runStorageConformance({ create: async () => {
  const db = new Database(':memory:');
  return { storage: bunSqliteStorage(db), driver: bunSqliteDriver(db), cleanup: async () => db.close() };
} });
assert.deepEqual(sqlite.failures, []);
console.log(`Bun SQLite: ${sqlite.checks.length} conformance checks passed`);

const url = process.env.MANTLE_PG_URL;
if (!url) { console.log('Bun PostgreSQL skipped: set MANTLE_PG_URL'); process.exit(0); }
const admin = new SQL(url, { prepare: false });
const pools: SQL[] = [];
const fresh = async () => {
  const schema = `bun_${crypto.randomUUID().replace(/-/g, '')}`;
  await admin.unsafe(`CREATE SCHEMA ${schema}`);
  const sql = new SQL(url, { prepare: false, bigint: true, connection: { search_path: schema } });
  pools.push(sql);
  return { sql, storage: bunPostgresStorage(sql), driver: bunDatabaseDriver(sql), cleanup: async () => { await sql.close(); await admin.unsafe(`DROP SCHEMA ${schema} CASCADE`); } };
};
try {
  const pg = await runStorageConformance({ compile: pgCompile, create: fresh });
  assert.deepEqual(pg.failures, []);
  console.log(`Bun PostgreSQL: ${pg.checks.length} conformance checks passed`);
  const engine = await fresh();
  try {
    const plan: any = { version: 2, fingerprint: 'bun-native', schemas: {}, views: {}, procedures: {}, triggers: {} };
    const { executor } = await engine.storage.prepare(plan);
    const select = async (text: string) => {
      const compiled = await compileSql(text, { schemas: { truth: { fields: { flag: 'bool', n: 'numeric(12,2)' } } }, inputs: {}, kind: 'view' }, pgCompile);
      assert.equal(compiled.ok, true, JSON.stringify(compiled));
      return executor.select({ ir: compiled.plan.stmts[0], binds: [] });
    };
    assert.deepEqual(await select('SELECT abs(-1), COALESCE(NULL,2)'), [{ abs: 1, coalesce: 2 }]);
    const exact = "SELECT '2026-10-01 12:01:02.123456+00'::timestamptz AS t, 123::int8 AS n, '\"123\"'::jsonb AS j";
    for (const text of [exact, `/* prefix */ ${exact}`, `WITH r AS (${exact}) SELECT * FROM r`]) {
      assert.deepEqual((await engine.driver.batch([{ sql: text }]))[0].rows, [{ t: '2026-10-01T12:01:02.123456Z', n: 123, j: '123' }]);
    }
    assert.deepEqual((await engine.driver.batch([{ sql: 'SELECT ?1::timestamptz AS t', binds: [new Date('2026-01-01T00:00:00.123Z')] }]))[0].rows, [{ t: '2026-01-01T00:00:00.123000Z' }]);
    await engine.driver.batch([{ sql: 'CREATE TABLE truth (flag bool, n numeric(12,2))' }, { sql: 'INSERT INTO truth VALUES (true,1.20),(false,2.30)' }]);
    const rows = await select('SELECT CASE WHEN flag THEN n ELSE 0.00::numeric(12,2) END AS n, COALESCE(n, 0::numeric(12,2)) AS c FROM truth');
    assert.deepEqual(rows, [{ n: '1.20', c: '1.20' }, { n: '0.00', c: '2.30' }]);
    const codes = new Map<string, string>();
    const auth = createMantleAuth({ database: bunAuthDatabase(engine.sql), driver: engine.driver, baseURL: 'http://localhost', secret: crypto.randomUUID()+crypto.randomUUID(), ipAddressHeaders: ['x-real-ip'], methods: [{ kind: 'email-otp', sender: { send: async ({to,text}) => void codes.set(to, /\b(\d{6})\b/.exec(text)![1]!) } }], bootstrapOwner: { match: 'email', value: 'owner@bun.test' } });
    const post = (path: string, body: unknown) => auth.handler(new Request(`http://localhost/api/auth${path}`, { method:'POST', headers:{'content-type':'application/json',origin:'http://localhost','x-real-ip':'127.0.0.1'},body:JSON.stringify(body) }));
    assert.equal((await post('/email-otp/send-verification-otp',{email:'owner@bun.test',type:'sign-in'})).status,200);
    for(let i=0;i<100&&!codes.has('owner@bun.test');i++)await Bun.sleep(10);
    const login=await post('/sign-in/email-otp',{email:'owner@bun.test',otp:codes.get('owner@bun.test')});assert.equal(login.status,200);
    const request=new Request('http://localhost/admin/api/staff',{headers:{cookie:login.headers.getSetCookie().map(c=>c.split(';')[0]).join('; ')}});
    assert.equal((await auth.listUsers(request))[0].role,'owner');
    const connect=bunPgConnect(engine.sql);const first=await connect();const second=await connect();
    try { assert.notEqual((await first.query('SELECT pg_backend_pid() AS pid')).rows[0].pid,(await second.query('SELECT pg_backend_pid() AS pid')).rows[0].pid); } finally { await first.end();await first.end();await second.end(); }
    console.log('Bun PostgreSQL: exact values, expressions, CTE/comments, auth and reserved connections passed');
  } finally { await engine.cleanup(); }
} finally { for(const sql of pools)await sql.close();await admin.close(); }
