import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
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
  for (const user of [{ id: 'host:x' }, { id: 'system:x' }, { id: 'x', role: 'Bad-role' }, { id: 'x', region: ['XX'] }, { id: 'x', stores: ['A'] }, { id: 'x', unused: { all: false } }, { id: 'x', region: { all: true, extra: true } }])
    expect(() => hostCaller({ ...mantleProps(), user }, { tenant: 'example', fields })).toThrow(expect.objectContaining({ code: 'HOST_CONTRACT' }));
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
    const foreignSession = await restCall(mantleProps({ credential: 'session' }), '/api/write', JSON.stringify(input), { origin: 'https://foreign.test' }); expect(foreignSession.status).toBe(403);
    expect((await restCall(mantleProps(), '/api/write', JSON.stringify(input))).status).toBe(200);
    expect(db.query('SELECT title FROM records WHERE id=?').get(own.id)).toEqual({ title: 'updated' });
    const malformedRpc = await tools(request('/mcp', 'POST', JSON.stringify({ method: 'tools/call', params: { name: 'touch' } })), {}, { props: { mantle: mantleProps() } }); expect(malformedRpc.status).toBe(400); expect(touched).toBe(1);
    const badBody = await restCall(mantleProps(), '/api/write', '{'); expect(badBody.status).toBe(400); expect((await badBody.json()).error.code).toBe('INPUT_VALIDATION_FAILED');
    for (const headers of [{ cookie: 'better-auth.session_token=ignored' }, { authorization: 'Bearer ignored' }]) {
      const r = await api(request('/api/write', 'POST', '{}', headers), {}); expect(r.status).toBe(401);
      expect((await tools(request('/mcp/admin', 'POST', '{}', headers), {})).status).toBe(401);
    }
    const local = { ...options, gateway: undefined };
    expect((await rest(local)(request('/api/views/public-records'), {}, { props: { mantle: mantleProps() } })).status).toBe(412);
    expect((await mcp(local)(request('/mcp', 'POST', '{}'), {}, { props: { mantle: mantleProps() } })).status).toBe(412);
    expect(resolves).toBe(0);
  } finally { db.close(); await rm(dir, { recursive: true, force: true }); }
});
