import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { SQL } from 'bun';
import { mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { generateFromSources } from '../src/infrastructure/generate.js';
import { writeGenerated } from './apps/link.js';
import { fixtureCaller } from './apps/fixtures.js';

const schema = `apiVersion: cms.mantle.aotter.net/v2
kind: Schema
metadata: {name: items}
spec:
  title: Items
  lifecycle: operational
  scope: "owner = auth.uid()"
  indexes: [[owner, bucket]]
  schema:
    type: object
    required: [owner, title, bucket]
    properties: {owner: {type: string}, title: {type: string}, bucket: {type: integer}}
`;
const definitions = [
  ['latest', 'public', 'SELECT id, title FROM items ORDER BY id LIMIT 3'],
  ['exact', 'public', 'SELECT id, title FROM items ORDER BY id LIMIT 4'],
  ['empty', 'public', 'SELECT id, title FROM items ORDER BY id LIMIT 0'],
  ['grouped', 'public', 'SELECT bucket, count(*) AS total FROM items GROUP BY bucket ORDER BY bucket LIMIT 3'],
  ['admin-latest', 'admin', 'SELECT id, title FROM items ORDER BY id LIMIT 3'],
  ['internal-latest', 'internal', 'SELECT id, title FROM items ORDER BY id LIMIT 3'],
] as const;
const source = schema + definitions.map(([name, surface, sql]) => `---
apiVersion: cms.mantle.aotter.net/v2
kind: View
metadata: {name: ${name}}
spec:
  surface: ${surface}
  requires: {auth: {all: [ctx.${surface === 'admin' ? 'admin' : 'user'}]}}
  sql: ${sql}
`).join('');
async function generated(target: 'bun-sqlite' | 'cloudflare-d1' | 'bun-postgres' | 'cloudflare-postgres') {
  const result = await generateFromSources({ target, admin: true, sources: { sources: [{ sourceId: 'limited.yaml', text: source }] } });
  if (!result.ok) throw Error(JSON.stringify(result.diagnostics));
  return result.files;
}
async function collect(read: (options: { limit: number; cursor?: string }) => Promise<any>, limit: number) {
  const rows: any[] = [], sizes: number[] = []; let cursor: string | undefined;
  do {
    const page = await read({ limit, ...(cursor ? { cursor } : {}) });
    rows.push(...page.rows); sizes.push(page.rows.length); cursor = page.nextCursor;
    if (sizes.length > 10) throw Error('Limited View did not finish');
  } while (cursor);
  return { rows, sizes };
}

for (const target of ['bun-sqlite', 'bun-postgres'] as const) test.skipIf(target === 'bun-postgres' && !process.env.MANTLE_NEXT_BUN_PG_URL)(`${target}: authored LIMIT bounds scoped, grouped, internal, REST, MCP and Admin pages`, async () => {
  const files = await generated(target), dir = await mkdtemp(join(import.meta.dir, 'apps/.paging-limit-'));
  const sqlite = target === 'bun-sqlite', db: any = sqlite ? new Database(':memory:') : new SQL(process.env.MANTLE_NEXT_BUN_PG_URL!, { max: 1 });
  const namespace = 'paging_limit_' + crypto.randomUUID().replaceAll('-', '');
  const execute = (sql: string) => sqlite ? db.exec(sql) : db.unsafe(sql);
  try {
    const native = JSON.stringify(resolve(import.meta.dir, '../../mantle-admin/src/server/native.ts'));
    await writeGenerated(dir, Object.fromEntries(Object.entries(files).map(([name, text]) => [name, text.replaceAll('"@aotter/mantle-admin/server/native"', native)])));
    if (!sqlite) { await execute(`CREATE SCHEMA ${namespace}`); await execute(`SET search_path TO ${namespace}`); }
    await execute(files['schema.sql']!);
    for (const owner of ['a', 'b']) for (let i = 1; i <= 6; i++) await execute(`INSERT INTO items(id,version,created_at,updated_at,owner,title,bucket) VALUES ('${owner + i}',1,${sqlite ? '0,0' : 'now(),now()'},'${owner}','${owner + i}',${i})`);
    for (const owner of ['a', 'b']) {
      const caller = fixtureCaller({ kind: 'user', subject: owner, role: 'admin', admin: true, credential: 'oauth', scopes: ['mcp'], credentialId: null, clientId: null });
      for (const [name] of definitions) {
        const bare = (await import(join(dir, `views/${name}.ts`))).default;
        const page = (await import(join(dir, `paged/views/${name}.ts`))).default;
        const expected = await bare(db, caller, {});
        for (const limit of [1, 2, 3, 100]) {
          const got = await collect(options => page(db, caller, {}, options), limit);
          expect(got.rows).toEqual(expected);
          if (name === 'latest' && limit === 2) expect(got.sizes).toEqual([2, 1]);
          if (name === 'exact' && limit === 2) expect(got.sizes).toEqual([2, 2]);
        }
      }
      const { rest } = await import(join(dir, 'rest.ts'));
      const { mcp } = await import(join(dir, 'mcp.ts'));
      const { adminBindings } = await import(join(dir, 'admin-bindings.ts'));
      const options = { db: () => db, caller: () => caller }, http = rest(options), rpc = mcp(options);
      const expected = [1, 2, 3].map(i => ({ id: owner + i, title: owner + i }));
      const admin = adminBindings().views.find((view: any) => view.name === 'admin-latest');
      expect((await collect(paging => admin.page(db, caller, {}, paging), 2)).rows).toEqual(expected);
      const get = async (paging: { limit: number; cursor?: string }) => {
        const query = new URLSearchParams({ limit: String(paging.limit), ...(paging.cursor ? { cursor: paging.cursor } : {}) });
        const response = await http(new Request('https://app.test/api/views/latest?' + query), {});
        expect(response!.status).toBe(200); return response!.json();
      };
      expect((await collect(get, 2)).rows).toEqual(expected);
      const call = async (paging: { limit: number; cursor?: string }) => {
        const response = await rpc(new Request('https://app.test/mcp', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'latest', arguments: paging } }) }), {});
        expect(response!.status).toBe(200);
        const text = await response!.text(), body = JSON.parse(text.startsWith('event:') ? text.split('data: ')[1]!.split('\n')[0]! : text);
        expect(body.error).toBeUndefined(); expect(body.result.isError).not.toBe(true); return body.result.structuredContent;
      };
      expect((await collect(call, 2)).rows).toEqual(expected);
    }
  } finally { if (sqlite) db.close(); else { await execute(`DROP SCHEMA IF EXISTS ${namespace} CASCADE`); await db.close(); } await rm(dir, { recursive: true, force: true }); }
});

for (const target of ['bun-sqlite', 'cloudflare-d1', 'bun-postgres', 'cloudflare-postgres'] as const) test(`${target}: first and next SQL retain authored LIMIT before keyset filtering`, async () => {
  const files = await generated(target);
  for (const [name, , sql] of definitions) {
    const limit = Number(/LIMIT (\d+)$/.exec(sql)![1]);
    const code = files[`paged/views/${name}.ts`]!;
    // Both pre-lowered shapes preserve the same inner limited row set.
    expect(code.match(new RegExp(`LIMIT ${limit}\\s*\\)`, 'g'))?.length ?? 0).toBeGreaterThanOrEqual(2);
  }
});

test('unordered LIMIT remains refused by the closed SQL grammar', async () => {
  const result = await generateFromSources({ target: 'bun-sqlite', sources: { sources: [{ sourceId: 'unordered.yaml', text: source.replace('ORDER BY id LIMIT 3', 'LIMIT 1') }] } });
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.diagnostics.some(diagnostic => diagnostic.code === 'SQL_SHAPE')).toBe(true);
});
