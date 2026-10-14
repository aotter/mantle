import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { userCaller } from '../src/kernel/user-caller.js';
import { hostCaller } from '../src/kernel/host-caller.js';
import { fieldsOf, hasRole, isAll, modeOf, userBinds } from '../src/kernel/user-fields.js';
import { binds } from '../src/kernel/binds.js';
import { isAdmin, type Caller } from '../src/kernel/contracts.js';
import { hostAs } from '../src/testing/index.js';
import { generateOrThrow, writeGenerated } from './apps/link.js';
import { gatewaySource, mantleProps, invalidProps } from './gateway-fixture.js';

const fields = { region: { type: 'string' as const, multiple: true, enum: ['TW', 'JP'] }, stores: { type: 'string' as const, multiple: false } };
test('host contract shares validation, freezes identity, preserves layers and loses copied authority', () => {
  const props = mantleProps({ authenticatedAs: 'snapshot', user: { id: 'person', role: 'editor,content-admin', region: { all: true }, stores: 'A' } });
  for (const layer of ['admin', 'member'] as const) {
    const caller = hostCaller({ ...props, layer }, { tenant: 'example', fields });
    expect(caller.kind).toBe(layer === 'admin' ? 'host' : 'user'); expect(caller.subject).toBe(layer === 'admin' ? 'host:person' : 'person');
    expect(isAdmin(caller)).toBe(layer === 'admin'); expect(hasRole(caller, 'content-admin')).toBe(true); expect(isAll(caller, 'region')).toBe(true);
    expect(caller.authenticatedAs).toBe('snapshot'); expect(caller.requestId).toBe(props.requestId); expect(caller.credential).toBe('oauth');
    expect(Object.isFrozen(fieldsOf(caller).region)).toBe(true); expect(isAdmin({ ...caller })).toBe(false); expect(fieldsOf({ ...caller })).toEqual({});
    expect(binds({}, [{ k: 'uid' }], caller)).toEqual([caller.subject]);
    const fixture = hostAs({ ...props, layer }); expect(fixture.authenticatedAs).toBe('snapshot'); expect(isAll(fixture, 'region')).toBe(true);
    if (layer === 'admin') expect(() => modeOf({ ...caller })).toThrow(expect.objectContaining({ code: 'AUTH_DENIED' }));
    expect(() => userBinds(true)({ k: 'user', field: 'missing', type: 'string', multiple: true }, caller)).toThrow(expect.objectContaining({ code: 'HOST_CONTRACT', fields: { field: 'missing' } }));
  }
  for (const id of ['HOST:x', 'System:x']) expect(() => userCaller({ id })).toThrow(expect.objectContaining({ code: 'USER_FIELD_INVALID' }));
  for (const user of [{ id: 'host:x' }, { id: 'system:x' }, { id: 'HOST:x' }, { id: 'SyStEm:x' }, { id: 'x', role: 'Bad-role' }, { id: 'x', region: ['XX'] }, { id: 'x', stores: ['A'] }, { id: 'x', unused: { all: false } }, { id: 'x', region: { all: true, extra: true } }])
    expect(() => hostCaller({ ...mantleProps(), user }, { tenant: 'example', fields })).toThrow(expect.objectContaining({ code: 'HOST_CONTRACT' }));
});

test('v1 refuses every reserved control and validates only own field specs', () => {
  for (const field of ['dryRun', 'target', 'targetHash', 'bodyDigest']) for (const value of [true, 'reserved', false, undefined]) {
    expect(() => hostCaller({ ...mantleProps(), [field]: value }, { tenant: 'example' })).toThrow(expect.objectContaining({ code: 'HOST_CONTRACT', status: 412, fields: { field } }));
  }
  const user = { ...mantleProps().user, constructor: 'unused' };
  expect(hostCaller(mantleProps({ layer: 'member', user }), { tenant: 'example', fields: { region: fields.region } }).subject).toBe('person');
  const inherited = Object.create({ constructor: { type: 'number', multiple: false } });
  expect(hostCaller(mantleProps({ user }), { tenant: 'example', fields: inherited }).fields).toEqual({});
});

test('generated REST and MCP enforce gateway contracts, scope, freshness and local credential isolation', async () => {
  const files = await generateOrThrow('bun-sqlite', [{ sourceId: 'gateway.yaml', text: gatewaySource }]);
  const dir = await mkdtemp(resolve(import.meta.dir, '.gateway-')), db = new Database(':memory:');
  let touched = 0, resolves = 0, acquired = 0, authorized: Caller | undefined;
  try {
    await writeGenerated(dir, files); db.exec(files['schema.sql']!);
    const app = await import(resolve(dir, 'generated.ts'));
    for (const [region, store] of [['TW', 'A'], ['JP', 'A'], ['TW', 'B']] as const) await app.store(db, { kind: 'system', reason: 'fixture' }).collection('records').insert({ region, store, title: region + store });
    const { rest } = await import(resolve(dir, 'rest.ts')), { mcp } = await import(resolve(dir, 'mcp.ts'));
    const options = { handlers: { touch: (ctx: any) => { touched++; return { subject: ctx.caller.subject }; } }, gateway: { tenant: 'example' }, db: () => { acquired++; return db; }, caller: () => { resolves++; throw Error('Local auth must not load'); }, authorize: (_target: unknown, caller: Caller) => { authorized = caller; return true; } };
    const api = rest(options), tools = mcp(options);
    const request = (path: string, method = 'GET', body?: string, headers = {}) => new Request('https://app.test' + path, { method, body, headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers } });
    const restCall = (props: unknown, path = '/api/views/public-records', raw?: string, headers = {}) => api(request(path, raw === undefined ? 'GET' : 'POST', raw, headers), {}, { props: { mantle: props } });
    const mcpCall = (props: unknown, name = 'public_records', args = {}, path = '/mcp', headers = {}) => tools(request(path, 'POST', JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }), headers), {}, { props: { mantle: props } });
    const rpcData = async (response: Response) => { const text = await response.text(); return JSON.parse(text.startsWith('event:') ? text.split('data: ')[1]!.split('\n')[0]! : text); };
    for (const layer of ['admin', 'member'] as const) {
      const props = mantleProps({ layer, user: { id: 'person', role: 'admin', region: ['TW'], stores: ['A'] } });
      const response = await restCall(props); expect(response.status).toBe(200); expect((await response.json()).rows.map((r: any) => r.title)).toEqual(['TWA']);
      expect(authorized!.kind).toBe(layer === 'admin' ? 'host' : 'user'); expect(isAdmin(authorized!)).toBe(layer === 'admin');
      const rpc = await mcpCall(props); expect(rpc.status).toBe(200); expect((await rpcData(rpc)).result.structuredContent.rows.map((r: any) => r.title)).toEqual(['TWA']);
      expect((await mcpCall(props, 'admin_records', {}, '/mcp/admin')).status).toBe(layer === 'admin' ? 200 : 403);
      const denied = await restCall({ ...props, layer: 'member' }, '/api/write', JSON.stringify({ id: 'x', version: 1, title: 'denied' })); expect(denied.status).toBe(403); expect((await denied.json()).error.code).toBe('AUTH_DENIED');
    }
    const before = acquired;
    for (const props of invalidProps()) for (const call of [restCall, mcpCall]) { const r = await call(props); expect(r.status).toBe(412); expect((await r.json()).error.code).toBe('HOST_CONTRACT'); }
    expect(acquired).toBe(before);
    for (const region of [undefined, []]) for (const call of [restCall, mcpCall]) {
      const user = { ...mantleProps().user }; if (region) user.region = region; else delete user.region;
      const r = await call(mantleProps({ user })); expect(r.status).toBe(412); expect(await r.json()).toEqual({ error: { code: 'HOST_CONTRACT', field: 'region' } });
    }
    const beforeReserved = db.query("SELECT id,version FROM records WHERE region='TW' AND store='A'").get() as { id: string; version: number };
    for (const field of ['dryRun', 'target', 'targetHash', 'bodyDigest']) {
      const props = { ...mantleProps(), [field]: field === 'dryRun' ? true : 'views/public-records' };
      for (const response of [await restCall(props, '/api/write', JSON.stringify({ ...beforeReserved, title: 'must not write' })), await mcpCall(props, 'touch')]) {
        expect(response.status).toBe(412); expect(await response.json()).toEqual({ error: { code: 'HOST_CONTRACT', field } });
      }
    }
    expect(touched).toBe(0); expect(db.query("SELECT title FROM records WHERE region='TW' AND store='A'").get()).toEqual({ title: 'TWA' });
    const constructorField = await restCall(mantleProps({ layer: 'member', user: { ...mantleProps().user, constructor: 'unused' } }));
    expect(constructorField.status).toBe(200);
    const snapshot = mantleProps({ authenticatedAs: 'snapshot' });
    expect((await restCall(snapshot)).status).toBe(200);
    expect((await mcpCall(snapshot)).status).toBe(200);
    for (const r of [await restCall(snapshot, '/api/write', '{}'), await mcpCall(snapshot, 'write'), await restCall(snapshot, '/api/touch', '{}'), await mcpCall(snapshot, 'touch')]) { expect(r.status).toBe(403); expect((await r.json()).error.code).toBe('STALE_CALLER'); }
    expect(touched).toBe(0);
    expect((await restCall(mantleProps(), '/api/touch', '{}')).status).toBe(200); expect(touched).toBe(1);
    const all = mantleProps({ user: { ...mantleProps().user, region: { all: true } } });
    expect((await (await restCall(all)).json()).rows.map((r: any) => r.title)).toEqual(['JPA', 'TWA']);
    const own = db.query("SELECT id,version FROM records WHERE region='TW' AND store='A'").get() as { id: string; version: number };
    const input = { ...own, title: 'updated' };
    const stale = { code: 'STALE_CALLER', status: 403 };
    for (const layer of ['admin', 'member'] as const) {
      const caller = hostAs(mantleProps({ authenticatedAs: 'snapshot', layer }));
      const store = app.store(db, caller, { handlers: options.handlers }), collection = store.collection('records');
      expect(await collection.findById(own.id)).not.toBeNull();
      expect(await store.views['public-records']({})).toHaveLength(1);
      for (const write of [collection.insert({ region: 'TW', store: 'A', title: 'snapshot-insert' }), collection.update(own.id, { title: 'snapshot-update' }, { lock: own.version }), collection.delete(own.id, { lock: own.version })]) await expect(Promise.resolve(write)).rejects.toMatchObject(stale);
      await expect(store.batch([collection.update(own.id, { title: 'snapshot-batch' }, { lock: own.version })])).rejects.toMatchObject(stale);
      await expect(store.transaction((tx: any) => tx.collection('records').delete(own.id, { lock: own.version }))).rejects.toMatchObject(stale);
      await expect(app.procedures.write(db, caller, input)).rejects.toMatchObject(stale);
      await expect(store.procedures.touch({})).rejects.toMatchObject(stale);
    }
    expect(touched).toBe(1); expect(db.query('SELECT count(*) AS n FROM records').get()).toEqual({ n: 3 });
    expect(db.query('SELECT title,version FROM records WHERE id=?').get(own.id)).toEqual({ title: 'TWA', version: own.version });
    const rpc = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'write', arguments: input } };
    const beforeTransport = acquired;
    for (const [headers, status] of [[{ accept: '' }, 406], [{ accept: 'text/html' }, 406], [{ 'content-type': 'text/plain' }, 415], [{ 'mcp-protocol-version': 'unsupported' }, 400]] as const) {
      for (const [path, body] of [['/mcp/admin', rpc], ['/mcp', { ...rpc, params: { name: 'touch', arguments: {} } }]] as const) {
        const transportRequest = request(path, 'POST', JSON.stringify(body), headers);
        if ('accept' in headers && headers.accept === '') transportRequest.headers.delete('accept');
        expect((await tools(transportRequest, {}, { props: { mantle: mantleProps() } })).status).toBe(status);
      }
    }
    for (const malformed of [{ ...rpc, jsonrpc: '1.0' }, { ...rpc, id: {} }, { ...rpc, params: [] }]) expect((await tools(request('/mcp/admin', 'POST', JSON.stringify(malformed)), {}, { props: { mantle: mantleProps() } })).status).toBe(400);
    expect(acquired).toBe(beforeTransport); expect(touched).toBe(1);
    expect(db.query('SELECT title,version FROM records WHERE id=?').get(own.id)).toEqual({ title: 'TWA', version: own.version });
    const foreignSession = await restCall(mantleProps({ credential: 'session' }), '/api/write', JSON.stringify(input), { origin: 'https://foreign.test' }); expect(foreignSession.status).toBe(403);
    expect((await restCall(mantleProps(), '/api/write', JSON.stringify(input))).status).toBe(200);
    expect(db.query('SELECT title FROM records WHERE id=?').get(own.id)).toEqual({ title: 'updated' });
    const current = db.query('SELECT version FROM records WHERE id=?').get(own.id) as { version: number };
    const mcpWrite = await mcpCall(mantleProps(), 'write', { ...input, version: current.version }, '/mcp/admin');
    expect(mcpWrite.status).toBe(200); expect((await rpcData(mcpWrite)).result.isError).toBeUndefined();
    expect(db.query('SELECT version,title FROM records WHERE id=?').get(own.id)).toEqual({ version: current.version + 1, title: 'updated' });
    const malformedRpc = await tools(request('/mcp', 'POST', JSON.stringify({ method: 'tools/call', params: { name: 'touch' } })), {}, { props: { mantle: mantleProps() } }); expect(malformedRpc.status).toBe(400); expect(touched).toBe(1);
    const badBody = await restCall(mantleProps(), '/api/write', '{'); expect(badBody.status).toBe(400); expect((await badBody.json()).error.code).toBe('INPUT_VALIDATION_FAILED');
    for (const headers of [{ cookie: 'better-auth.session_token=ignored' }, { authorization: 'Bearer ignored' }]) {
      const r = await api(request('/api/write', 'POST', '{}', headers), {}); expect(r.status).toBe(401);
      expect((await tools(request('/mcp/admin', 'POST', '{}', headers), {})).status).toBe(401);
    }
    const local = { ...options, gateway: undefined };
    expect((await rest(local)(request('/api/views/public-records'), {}, { props: { mantle: mantleProps() } })).status).toBe(412);
    expect((await mcp(local)(request('/mcp', 'POST', '{}'), {}, { props: { mantle: mantleProps() } })).status).toBe(412);
    // Workers pass `ctx.props` as `{}` on ordinary requests: only `props.mantle` is the host contract.
    const plain = { ...local, caller: () => ({ kind: 'anonymous' as const }) };
    for (const props of [{}, { other: true }]) {
      expect((await rest(plain)(request('/api/views/public-records'), {}, { props })).status).not.toBe(412);
      expect((await mcp(plain)(request('/mcp', 'POST', '{}'), {}, { props })).status).not.toBe(412);
    }
    const { web } = await import(resolve(dir, 'web.ts'));
    const webOptions = { gateway: options.gateway, db, caller: options.caller, origin: 'https://app.test', title: 'Records', description: 'Scoped records', pages: { '/records': { view: 'public-records', list: 'public-records', markdown: 'title' } } };
    const site = web(webOptions), localSite = web({ ...webOptions, gateway: undefined });
    for (const layer of ['admin', 'member'] as const) {
      const ctx = { props: { mantle: mantleProps({ layer, authenticatedAs: 'snapshot' }) } };
      for (const path of ['/llms.txt', '/sitemap.xml', '/records.md']) {
        const response = await site.fetch(request(path), {}, ctx); expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toBe('private, no-store');
        const text = await response.text(); if (path !== '/sitemap.xml') expect(text).toContain('updated'); expect(text).not.toContain('JPA'); expect(text).not.toContain('TWB');
      }
      expect(await site.head(request('/records'), {}, ctx)).toContain('rel="canonical"');
      expect((await localSite.fetch(request('/records.md'), {}, ctx)).status).toBe(412);
      await expect(localSite.head(request('/records'), {}, ctx)).rejects.toMatchObject({ code: 'HOST_CONTRACT', status: 412 });
    }
    for (const headers of [{ cookie: 'app-session' }, { authorization: 'Bearer app-token' }]) {
      expect((await site.fetch(request('/records.md', 'GET', undefined, headers), {})).status).toBe(401);
      expect((await site.fetch(request('/records.md', 'GET', undefined, headers), {}, { props: {} })).status).toBe(401);
    }
    const malformedWeb = await site.fetch(request('/records.md'), {}, { props: { mantle: mantleProps({ dryRun: true }) } }); expect(malformedWeb.status).toBe(412);
    expect(resolves).toBe(0);
    // Workers pass `ctx.props` as `{}` on ordinary requests: only `props.mantle` is the host contract.
    for (const props of [{}, { other: 1 }]) expect((await localSite.fetch(request('/records.md'), {}, { props })).status).not.toBe(412);
  } finally { db.close(); await rm(dir, { recursive: true, force: true }); }
});

test('snapshot publishing transitions refuse before changing rows', async () => {
  const source = gatewaySource.split('\n---\n').filter(text => JSON.parse(text).kind === 'Schema').join('\n---\n').replace('"lifecycle":"operational"', '"lifecycle":"publishing"');
  const files = await generateOrThrow('bun-sqlite', [{ sourceId: 'publishing.yaml', text: source }]);
  const dir = await mkdtemp(resolve(import.meta.dir, '.gateway-')), db = new Database(':memory:');
  try {
    await writeGenerated(dir, files); db.exec(files['schema.sql']!);
    const app = await import(resolve(dir, 'generated.ts'));
    const own = await app.store(db, { kind: 'system', reason: 'fixture' }).collection('records').insert({ region: 'TW', store: 'A', title: 'draft' });
    const snapshot = hostAs(mantleProps({ authenticatedAs: 'snapshot' }));
    for (const verb of ['publish', 'unpublish', 'archive']) {
      const transition = (await import(resolve(dir, 'procedures', 'records.' + verb + '.ts'))).default;
      await expect(transition(db, snapshot, { id: own.id, expectedVersion: own.version })).rejects.toMatchObject({ code: 'STALE_CALLER', status: 403 });
    }
    expect(db.query('SELECT title,status,version FROM records').get()).toEqual({ title: 'draft', status: 'draft', version: own.version });
  } finally { db.close(); await rm(dir, { recursive: true, force: true }); }
});
