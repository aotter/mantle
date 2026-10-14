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
