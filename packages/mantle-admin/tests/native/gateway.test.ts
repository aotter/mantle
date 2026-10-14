import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { admin } from '../../src/server/index.js';
import { entries } from '../../src/server/entries.js';
import { siteRoutes } from '../../src/server/site.js';
import { generateAdmin, writeAdminFixture } from './generated-fixture.js';
import { gatewaySource, mantleProps, invalidProps, pinned } from '../../../mantle/tests/gateway-fixture.js';

test('Admin gateway enforces layers, draft scope, contract errors, stale writes and member refusal', async () => {
  const source = gatewaySource.split('\n---\n').filter(text => !['Procedure', 'Trigger'].includes(JSON.parse(text).kind)).join('\n---\n').replace('"lifecycle":"operational"', '"lifecycle":"publishing"');
  const files = await generateAdmin('bun-sqlite', source), dir = await mkdtemp(resolve(import.meta.dir, '../.gateway-')), db = new Database(':memory:');
  const events: any[] = [];
  let resolves = 0, writes = 0, directory = 0;
  try {
    await writeAdminFixture(dir, files); db.exec(files['schema.sql']!);
    const app = await import(resolve(dir, 'generated.ts')), { adminBindings } = await import(resolve(dir, 'admin-bindings.ts'));
    const system = app.store(db, { kind: 'system', reason: 'fixture' }).collection('records');
    const own = await system.insert({ region: 'TW', store: 'A', title: 'own draft' });
    await system.insert({ region: 'JP', store: 'A', title: 'other region' }); await system.insert({ region: 'TW', store: 'B', title: 'other store' });
    const bindings = adminBindings();
    const { targets: generatedTargets } = await import(resolve(dir, 'access-targets.ts'));
    const targets = {...generatedTargets, 'admin:PATCH /save': {targetHash:'custom-save',readOnly:false,opaque:true,requires:{all:['ctx.admin']}}};
    const options = { onAccess:(event:any)=>{events.push(event);}, accessTargets: async () => targets, gateway: { tenant: 'example' }, db: () => db, caller: () => { resolves++; throw Error('Local auth must not load'); }, routes: [...entries(bindings.schemas, bindings.adapter), ...siteRoutes({ identity: { directory: () => { directory++; return { listMembers: async () => ({ items: [], previousCursor: null, nextCursor: null }) }; } } }), { method: 'PATCH', path: '/save', run: () => { writes++; return { ok: true }; } }] };
    const api = admin(bindings.metadata, bindings.views, bindings.operations, options);
    const ask = async (props: unknown, path = '/entries?collection=records', method = 'GET', body?: string, headers = {}) => api(new Request('https://app.test/admin/api' + path, { method, body, headers: { origin: 'https://app.test', ...headers } }), {}, { props: { mantle: await pinned(props, targets, `admin:${method} ${path.split('?')[0]!.replace(/\/entries\/[^/]+/, '/entries/:id').replace(/\/operations\/[^/]+/, '/operations/:name')}`) } });
    const result = await ask(mantleProps()); expect(result!.status).toBe(200); const page = await result!.json(); expect(JSON.stringify(page)).toContain('own draft'); expect(JSON.stringify(page)).not.toContain('other region'); expect(JSON.stringify(page)).not.toContain('other store');
    const member = await ask(mantleProps({ layer: 'member', user: { ...mantleProps().user, role: 'admin' } })); expect(member!.status).toBe(403); expect(await member!.json()).toEqual({ error: { code: 'AUTH_DENIED', target: 'admin' } });
    for (const props of invalidProps()) { const response = await ask(props); expect(response!.status).toBe(412); expect((await response!.json()).error.code).toBe('HOST_CONTRACT'); }
    for (const region of [undefined, []]) {
      const user = { ...mantleProps().user }; if (region) user.region = region; else delete user.region;
      const response = await ask(mantleProps({ user })); expect(response!.status).toBe(412); expect((await response!.json()).error).toMatchObject({ code: 'HOST_CONTRACT', field: 'region' });
    }
    const beforeDry = db.query('SELECT title,version FROM records WHERE id=?').get(own.id);
    const raw = JSON.stringify({data:{title:'dry'},expectedVersion:own.version});
    const dry = await ask(mantleProps({dryRun:true}), `/entries/${own.id}?collection=records`, 'PATCH', raw);
    expect(dry!.status).toBe(200); expect((await dry!.json()).event).toEqual(events.at(-1));
    expect(events.at(-1)).toMatchObject({outcome:'allow',dryRun:true,target:'admin:PATCH /entries/:id'});
    expect(db.query('SELECT title,version FROM records WHERE id=?').get(own.id)).toEqual(beforeDry);
    const unpinned = {...mantleProps()}; delete (unpinned as any).target; delete (unpinned as any).targetHash;
    const required = await api(new Request('https://app.test/admin/api/entries?collection=records'), {}, {props:{mantle:unpinned}});
    expect(required!.status).toBe(412); expect(events.at(-1)).toMatchObject({outcome:'error',reason:'HOST_CONTRACT'});
    const badPin = await ask(mantleProps({target:'admin:GET /me'})); expect(badPin!.status).toBe(412); expect(events.at(-1)).toMatchObject({outcome:'error',reason:'TARGET_MISMATCH'});
    const snapshot = mantleProps({ authenticatedAs: 'snapshot' }); expect((await ask(snapshot))!.status).toBe(200);
    for (const [path, method, body] of [['/save', 'PATCH', '{}'], ['/entries', 'POST', '{}'], ['/operations/write', 'POST', '{}'], [`/entries/${own.id}/publish?collection=records`, 'POST', '{}']]) {
      const response = await ask(snapshot, path, method, body); expect(response!.status).toBe(403); expect((await response!.json()).error.code).toBe('STALE_CALLER');
    }
    expect(writes).toBe(0);
    const all = await ask(mantleProps({ user: { ...mantleProps().user, region: { all: true } } })); expect(all!.status).toBe(200); const allText = await all!.text(); expect(allText).toContain('other region'); expect(allText).not.toContain('other store');
    const malformed = await ask(mantleProps(), '/save', 'PATCH', '{'); expect(malformed!.status).toBe(400); expect((await malformed!.json()).error.code).toBe('INPUT_VALIDATION_FAILED');
    for (const credential of ['session', 'oauth'] as const) {
      const response = await ask(mantleProps({ credential }), '/save', 'PATCH', '{}', { origin: 'https://foreign.test' }); expect(response!.status).toBe(credential === 'session' ? 403 : 200);
    }
    for (const [path, method, code] of [['/missing', 'GET', 'NOT_FOUND'], ['/save', 'GET', 'METHOD_NOT_ALLOWED']]) {
      const response = await ask(mantleProps(), path, method); const payload = await response!.json(); expect(payload.error.code).toBe(code); expect(payload.error).not.toHaveProperty('message');
    }
    const members = await ask(mantleProps(), '/members'); expect(members!.status).toBe(403); expect((await members!.json()).error.code).toBe('AUTH_DENIED'); expect(directory).toBe(0);
    for (const headers of [{ cookie: 'better-auth.session_token=ignored' }, { authorization: 'Bearer ignored' }]) expect((await api(new Request('https://app.test/admin/api/me', { headers }), {}))!.status).toBe(401);
    const local = admin(bindings.metadata, bindings.views, bindings.operations, { ...options, gateway: undefined });
    expect((await local(new Request('https://app.test/admin/api/me'), {}, { props: { mantle: mantleProps() } }))!.status).toBe(412);
    for (const props of [{}, { other: true }]) for (const headers of [{ cookie: 'app-session' }, { authorization: 'Bearer app-token' }]) {
      expect((await api(new Request('https://app.test/admin/api/me', { headers }), {}, { props }))!.status).toBe(401);
    }
    // Workers pass `ctx.props` as `{}` on ordinary requests: only `props.mantle` is the host contract.
    const plain = admin(bindings.metadata, bindings.views, bindings.operations, { ...options, gateway: undefined, caller: () => ({ kind: 'anonymous' as const }) });
    for (const props of [{}, { other: true }]) expect((await plain(new Request('https://app.test/admin/api/me'), {}, { props }))!.status).not.toBe(412);
    const denied = admin(bindings.metadata, bindings.views, bindings.operations, { ...options, authorize: () => false });
    const refusal = await denied(new Request('https://app.test/admin/api/entries?collection=records'), {}, { props: { mantle: await pinned(mantleProps(), targets, 'admin:GET /entries') } }); expect(refusal!.status).toBe(403); expect((await refusal!.json()).error.code).toBe('AUTH_DENIED');
    expect(resolves).toBe(0);
  } finally { db.close(); await rm(dir, { recursive: true, force: true }); }
});
