import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { SQL } from 'bun';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { userCaller } from '../src/kernel/user-caller.js';
import { generateOrThrow, writeGenerated } from './apps/link.js';
await mkdir(resolve(import.meta.dir, 'apps/.generated'), { recursive: true });

// #1757: an x-mantle-ref to a scoped Schema names a row the caller sees, in the child's own partition (ADR-0034 §8).
const fields = { rep: { type: 'string' as const, multiple: true } };
const m = (kind: string, name: string, spec: object) => JSON.stringify({ apiVersion: 'cms.mantle.aotter.net/v2', kind, metadata: { name }, spec });
const proc = (name: string, sql: string) => m('Procedure', name, { title: name, input: { type: 'object', additionalProperties: false, properties: { id: { type: 'string' }, client: { type: 'string' }, rep: { type: 'string' }, list: { type: 'string' } } }, output: { type: 'object' }, handler: { sql } });
const text = [
  m('Schema', 'clients', { title: 'Clients', lifecycle: 'operational', scope: "rep IN auth.user('rep')", indexes: [['rep', 'id']], uniqueIndexes: [['code']], schema: { type: 'object', required: ['rep', 'name'], properties: { rep: { type: 'string' }, name: { type: 'string' }, code: { type: 'string' } } } }),
  m('Schema', 'contacts', { title: 'Contacts', lifecycle: 'operational', scope: "rep IN auth.user('rep')", indexes: [['rep', 'id']], uniqueIndexes: [['name']], schema: { type: 'object', required: ['rep', 'name'], properties: { rep: { type: 'string' }, name: { type: 'string' }, client_id: { type: 'string', 'x-mantle-ref': 'clients' }, client_code: { type: 'string', 'x-mantle-ref': { schema: 'clients', field: 'code' } } } } }),
  m('Schema', 'lists', { title: 'Lists', lifecycle: 'operational', scope: 'owner = auth.uid()', indexes: [['owner', 'id']], schema: { type: 'object', required: ['owner', 'name'], properties: { owner: { type: 'string' }, name: { type: 'string' } } } }),
  m('Schema', 'items', { title: 'Items', lifecycle: 'operational', scope: 'owner = auth.uid()', indexes: [['owner', 'id']], schema: { type: 'object', required: ['owner', 'name'], properties: { owner: { type: 'string' }, name: { type: 'string' }, list_id: { type: 'string', 'x-mantle-ref': 'lists' } } } }),
  proc('add', "INSERT INTO contacts(name, client_id) VALUES ('sql', input.client) RETURNING id"),
  proc('add_in', "INSERT INTO contacts(rep, name, client_id) VALUES (input.rep, 'sql-in', input.client) RETURNING id"),
  proc('add_many', "INSERT INTO contacts(rep, name, client_id) VALUES (input.rep, 'many', input.client) ON CONFLICT DO NOTHING RETURNING id"),
  proc('repoint', "INSERT INTO contacts(rep, name) VALUES (input.rep, 'up') ON CONFLICT(name) DO UPDATE SET client_id = input.client RETURNING id"),
  proc('copy', "INSERT INTO contacts(rep, name, client_id) SELECT rep, name, id FROM clients RETURNING id"),
  proc('self', 'UPDATE contacts SET client_id = name WHERE id = input.id RETURNING id'),
  proc('move', 'UPDATE contacts SET client_id = input.client WHERE id = input.id RETURNING id'),
  proc('add_item', "INSERT INTO items(name, list_id) VALUES ('sql-item', input.list) RETURNING id"),
].join('\n---\n');
const code = (run: () => Promise<unknown>) => run().then(() => 'ok', (e: { code?: string }) => e.code ?? String(e));

for (const pg of [false, true]) (pg && !process.env.MANTLE_NEXT_BUN_PG_URL ? test.skip : test)(`x-mantle-ref to a scoped Schema: the parent exists, is visible and shares the partition (${pg ? 'PostgreSQL' : 'SQLite'})`, async () => {
  const files = await generateOrThrow(pg ? 'bun-postgres' : 'bun-sqlite', [{ sourceId: 'ref-integrity.yaml', text }]);
  const dir = await mkdtemp(resolve(import.meta.dir, 'apps/.generated/ref-integrity-')), namespace = 'ref_integrity_' + crypto.randomUUID().replaceAll('-', '');
  const db: any = pg ? new SQL(process.env.MANTLE_NEXT_BUN_PG_URL!, { max: 1 }) : new Database(':memory:');
  const rows = async (sql: string) => [...await (pg ? db.unsafe(sql) : Promise.resolve(db.query(sql).all()))];
  try {
    await writeGenerated(dir, files); const app = await import(resolve(dir, 'generated.ts'));
    if (pg) { await db.unsafe(`CREATE SCHEMA ${namespace}`); await db.unsafe(`SET search_path TO ${namespace}`); await db.unsafe(files['schema.sql']!); } else db.exec(files['schema.sql']!);
    const a = userCaller({ id: 'a', rep: 'A' }, { fields }), b = userCaller({ id: 'b', rep: 'B' }, { fields });
    const both = userCaller({ id: 'both', rep: ['A', 'B'] }, { fields }), every = userCaller({ id: 'every', rep: { all: true } }, { fields });
    const system = { kind: 'system', reason: 'fixture' } as const;
    const contacts = (caller: unknown) => app.store(db, caller).collection('contacts');
    const ca = await app.store(db, a).collection('clients').insert({ name: 'client-a', code: 'ca' });
    const cb = await app.store(db, b).collection('clients').insert({ name: 'client-b', code: 'cb' });

    // Store insert
    expect(await code(() => contacts(a).insert({ name: 'own', client_id: ca.id }))).toBe('ok');
    expect(await code(() => contacts(a).insert({ name: 'null ref', client_id: null }))).toBe('ok');
    expect(await code(() => contacts(a).insert({ name: 'no ref' }))).toBe('ok');
    expect(await code(() => contacts(b).insert({ name: 'foreign', client_id: ca.id }))).toBe('CONFLICT');           // invisible parent
    expect(await code(() => contacts(b).insert({ name: 'missing', client_id: 'does-not-exist' }))).toBe('CONFLICT');
    expect(await code(() => contacts(both).insert({ rep: 'B', name: 'cross', client_id: ca.id }))).toBe('CONFLICT'); // visible, other partition
    expect(await code(() => contacts(every).insert({ rep: 'B', name: 'cross-all', client_id: ca.id }))).toBe('CONFLICT');
    expect(await code(() => contacts(every).insert({ rep: 'A', name: 'all-same', client_id: ca.id }))).toBe('ok');
    expect(await code(() => contacts(b).insert({ name: 'by code', client_code: 'cb' }))).toBe('ok');               // object form: its field
    expect(await code(() => contacts(b).insert({ name: 'foreign code', client_code: 'ca' }))).toBe('CONFLICT');
    expect(await code(() => contacts(system).insert({ rep: 'B', name: 'trusted', client_id: 'does-not-exist' }))).toBe('ok'); // trusted: unchecked, like the other row rules
    // Store update
    const own = (await contacts(b).first({ where: { name: 'by code' } }))!;
    expect(await code(() => contacts(b).update(own.id, { client_id: ca.id }, { lock: own.version }))).toBe('CONFLICT');
    expect(await code(() => contacts(b).update(own.id, { client_id: cb.id }, { lock: own.version }))).toBe('ok');
    expect(await code(() => contacts(b).update(own.id, { client_code: 'ca' }, { lock: Number(own.version) + 1 }))).toBe('CONFLICT');
    expect(await code(() => contacts(b).update(own.id, { client_code: null }, { lock: Number(own.version) + 1 }))).toBe('ok');
    // SQL Procedure INSERT ... VALUES and UPDATE
    expect(await code(() => app.procedures.add(db, a, { client: ca.id }))).toBe('ok');
    expect(await code(() => app.procedures.add(db, b, { client: ca.id }))).toBe('CONFLICT');
    expect(await code(() => app.procedures.add(db, b, { client: 'does-not-exist' }))).toBe('CONFLICT');
    expect(await code(() => app.procedures.add(db, b, { client: null }))).toBe('ok');
    expect(await code(() => app.procedures.add_in(db, both, { rep: 'B', client: ca.id }))).toBe('CONFLICT');
    expect(await code(() => app.procedures.add_in(db, every, { rep: 'B', client: ca.id }))).toBe('CONFLICT');
    expect(await code(() => app.procedures.add_in(db, every, { rep: 'A', client: ca.id }))).toBe('ok');
    await app.procedures.add_many(db, b, { rep: 'B', client: ca.id }); // ON CONFLICT asserts no row count: a row whose parent is out of reach is not written, like a conflict
    await app.procedures.repoint(db, b, { rep: 'B', client: cb.id }); await app.procedures.repoint(db, b, { rep: 'B', client: cb.id });
    await app.procedures.repoint(db, b, { rep: 'B', client: ca.id }); // DO UPDATE SET: the conflict row is left as it is
    expect(await rows("SELECT client_id FROM contacts WHERE name = 'up'")).toEqual([{ client_id: cb.id }]);
    expect(await code(() => app.procedures.copy(db, b, {}))).toBe('AUTH_DENIED');                               // INSERT ... SELECT: trusted only
    expect(await code(() => app.procedures.copy(db, system, {}))).toBe('ok');
    expect(await code(() => app.procedures.move(db, b, { id: own.id, client: ca.id }))).toBe('CONFLICT');
    expect(await code(() => app.procedures.move(db, b, { id: own.id, client: cb.id }))).toBe('ok');
    expect(await code(() => contacts(every).insert({ rep: null, name: 'no partition', client_id: ca.id }))).not.toBe('ok');
    const named = await contacts(b).insert({ name: cb.id }); // a bare column in SET is the written row's, not the parent's
    expect(await code(() => app.procedures.self(db, b, { id: named.id }))).toBe('ok');
    // owner scope
    const la = await app.store(db, a).collection('lists').insert({ name: 'list-a' });
    expect(await code(() => app.store(db, a).collection('items').insert({ name: 'own item', list_id: la.id }))).toBe('ok');
    expect(await code(() => app.store(db, b).collection('items').insert({ name: 'foreign item', list_id: la.id }))).toBe('CONFLICT');
    expect(await code(() => app.procedures.add_item(db, b, { list: la.id }))).toBe('CONFLICT');
    expect(await code(() => app.procedures.add_item(db, a, { list: la.id }))).toBe('ok');

    expect(await rows("SELECT name FROM contacts WHERE name LIKE 'many%'")).toEqual([]);
    expect(await rows('SELECT c.name FROM contacts c LEFT JOIN clients p ON p.id = c.client_id WHERE c.client_id IS NOT NULL AND (p.id IS NULL OR p.rep <> c.rep) ORDER BY c.name')).toEqual([{ name: 'trusted' }]);
    expect(await rows("SELECT name FROM contacts WHERE name IN ('client-a', 'client-b') ORDER BY name")).toEqual([{ name: 'client-a' }, { name: 'client-b' }]);
  } finally { if (pg) { await db.unsafe(`DROP SCHEMA IF EXISTS ${namespace} CASCADE`); await db.close(); } else db.close(); await rm(dir, { recursive: true, force: true }); }
});

test('SET of a checked reference takes no subquery for callers: it could read the parent alias columns as its own', async () => {
  const via = proc('via', 'UPDATE contacts SET client_id = (SELECT id FROM clients WHERE name = input.client) WHERE id = input.id RETURNING id');
  await expect(generateOrThrow('bun-sqlite', [{ sourceId: 'via.yaml', text: text + '\n---\n' + via }])).rejects.toThrow("SET 'client_id', a reference to a scoped Schema, takes no subquery");
});
