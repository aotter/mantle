import { afterAll, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { SQL } from 'bun';
import postgres from 'postgres';
import { resolve } from 'node:path';
import { rm } from 'node:fs/promises';
import { userCaller } from '../src/kernel/user-caller.js';
import { generateOrThrow, loadFixtureSources, writeGenerated } from './apps/link.js';
import { d1Shim } from './apps/d1-shim.js';
import { verifyUserFields } from './user-fields-scenarios.js';
const directory = resolve(import.meta.dir, 'apps/.generated', `user-drivers-${crypto.randomUUID()}`);
afterAll(() => rm(directory, { recursive: true, force: true }));
async function generated(target: 'bun-sqlite' | 'cloudflare-d1' | 'bun-postgres') {
  const files = await generateOrThrow(target, await loadFixtureSources('user-fields.yaml'));
  await writeGenerated(resolve(directory, target), files);
  return { app: await import(resolve(directory, target, 'generated.ts')), ddl: files['schema.sql']! };
}
for (const target of ['bun-sqlite', 'cloudflare-d1'] as const) test(`${target} user fields and scoped Store scenarios`, async () => {
  const { app, ddl } = await generated(target), db = new Database(':memory:'); db.exec(ddl);
  try { expect(await verifyUserFields(app, target === 'bun-sqlite' ? db : d1Shim(db), userCaller)).toBeGreaterThan(54); }
  finally { db.close(); }
});
const url = process.env.MANTLE_NEXT_BUN_PG_URL;
for (const driver of ['bun', 'postgres.js'] as const) test.skipIf(!url)(`${driver} user field array encoding and scoped Store scenarios`, async () => {
  const { app, ddl } = await generated('bun-postgres'), name = `user_fields_${crypto.randomUUID().replaceAll('-', '')}`;
  const admin = new SQL(url!); await admin.unsafe(`CREATE SCHEMA "${name}"`);
  const db = driver === 'bun' ? new SQL({ url: url!, max: 1, connection: { search_path: name } }) : postgres(url!, { max: 1, connection: { search_path: name }, onnotice: () => {} });
  try { await (db.unsafe as (query: string, values: never[]) => PromiseLike<unknown>)(ddl, []); expect(await verifyUserFields(app, db, userCaller)).toBeGreaterThan(54); }
  finally { if (driver === 'bun') await (db as SQL).close(); else await (db as ReturnType<typeof postgres>).end(); await admin.unsafe(`DROP SCHEMA "${name}" CASCADE`); await admin.close(); }
});
// A user field scoping an integer column holds integers only.
const teamTasks = [
  { apiVersion: 'cms.mantle.aotter.net/v2', kind: 'Schema', metadata: { name: 'tasks' }, spec: { title: 'Tasks', lifecycle: 'operational', scope: "team IN auth.user('team')", indexes: [['team', 'id']], schema: { type: 'object', required: ['team', 'title'], properties: { team: { type: 'integer' }, title: { type: 'string' } } } } },
  { apiVersion: 'cms.mantle.aotter.net/v2', kind: 'Procedure', metadata: { name: 'add' }, spec: { title: 'Add', input: { type: 'object', additionalProperties: false, required: ['title'], properties: { title: { type: 'string' } } }, output: { type: 'object' }, handler: { sql: 'INSERT INTO tasks(title) VALUES (input.title) RETURNING id' } } },
].map(x => JSON.stringify(x)).join('\n---\n');
const code = (run: () => Promise<unknown>) => run().then(() => 'ok', (e: { code?: string }) => e.code ?? String(e));
async function integerPartition(target: 'bun-sqlite' | 'bun-postgres', db: unknown, rows: () => Promise<unknown>) {
  const files = await generateOrThrow(target, [{ sourceId: 'team-tasks.yaml', text: teamTasks }]), dir = resolve(directory, `team-${target}`);
  await writeGenerated(dir, files); const app = await import(resolve(dir, 'generated.ts'));
  await (db as { unsafe?: (q: string) => Promise<unknown>; exec?: (q: string) => void }).unsafe?.(files['schema.sql']!) ?? (db as Database).exec(files['schema.sql']!);
  expect(app.userFields.team).toEqual({ type: 'number', integer: true, multiple: true });
  const insertAs = (team: unknown) => async () => { const caller = userCaller({ id: 'member', team }, { fields: app.userFields });
    await app.store(db, caller).collection('tasks').insert({ title: 'store' }); await app.procedures.add(db, caller, { title: 'sql' }); };
  expect(await code(insertAs([7.5]))).toBe('USER_FIELD_INVALID');
  expect(await rows()).toEqual([]);
  expect(await code(insertAs([8]))).toBe('ok');
  expect(await rows()).toEqual([{ team: 8, title: 'sql' }, { team: 8, title: 'store' }]);
}
test('bun-sqlite: non-integer user field values are refused for integer partitions', async () => {
  const db = new Database(':memory:');
  try { await integerPartition('bun-sqlite', db, async () => db.query('SELECT team, title FROM tasks ORDER BY title').all()); } finally { db.close(); }
});
test.skipIf(!url)('bun-postgres: non-integer user field values are refused for integer partitions', async () => {
  const name = `team_${crypto.randomUUID().replaceAll('-', '')}`, admin = new SQL(url!); await admin.unsafe(`CREATE SCHEMA "${name}"`);
  const db = new SQL({ url: url!, max: 1, connection: { search_path: name } });
  try { await integerPartition('bun-postgres', db, async () => [...await db.unsafe('SELECT team::int AS team, title FROM tasks ORDER BY title')]); }
  finally { await db.close(); await admin.unsafe(`DROP SCHEMA "${name}" CASCADE`); await admin.close(); }
});
