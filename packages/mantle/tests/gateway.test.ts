import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { userCaller } from '../src/kernel/user-caller.js';
import { hostCaller } from '../src/kernel/host-caller.js';
import { fieldsOf, hasRole } from '../src/kernel/caller-identity.js';
import { isAll, modeOf } from '../src/kernel/user-fields.js';
import { binds } from '../src/kernel/binds.js';
import { isAdmin, type Caller } from '../src/kernel/contracts.js';
import { generateOrThrow, writeGenerated } from './apps/link.js';
import { gatewaySource, mantleProps, invalidProps, pinned } from './gateway-fixture.js';

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
    if (layer === 'admin') expect(() => modeOf({ ...caller })).toThrow(expect.objectContaining({ code: 'AUTH_DENIED' }));
  }
  for (const id of ['HOST:x', 'System:x']) expect(() => userCaller({ id })).toThrow(expect.objectContaining({ code: 'USER_FIELD_INVALID' }));
  for (const user of [{ id: 'host:x' }, { id: 'system:x' }, { id: 'HOST:x' }, { id: 'SyStEm:x' }, { id: 'x', role: 'Bad-role' }, { id: 'x', region: ['XX'] }, { id: 'x', stores: ['A'] }, { id: 'x', region: { all: true, extra: true } }])
    expect(() => hostCaller({ ...mantleProps(), user }, { tenant: 'example', fields })).toThrow(expect.objectContaining({ code: 'HOST_CONTRACT' }));
});

test('v1 validates supported forwarding controls and own field specs', () => {
  expect(hostCaller(mantleProps({dryRun: true}), {tenant:'example'})).toMatchObject({dryRun:true});
  for (const field of ['target','targetHash']) for (const value of [true, false, undefined])
    expect(() => hostCaller({...mantleProps(), [field]:value}, {tenant:'example'})).toThrow(expect.objectContaining({code:'HOST_CONTRACT', fields:{field}}));
  expect(() => hostCaller(mantleProps({dryRun: 'true' as any}), {tenant:'example'})).toThrow();
  const user = { ...mantleProps().user, constructor: 'unused', ignored: false as never };
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
    const { targets } = await import(resolve(dir, 'access-targets.ts'));
    const { rest } = await import(resolve(dir, 'rest.ts')), { mcp } = await import(resolve(dir, 'mcp.ts'));
    const options = { handlers: { touch: (ctx: any) => { touched++; return { subject: ctx.caller.subject }; } }, gateway: { tenant: 'example' }, db: () => { acquired++; return db; }, caller: () => { resolves++; throw Error('Local auth must not load'); }, authorize: (_target: unknown, caller: Caller) => { authorized = caller; return true; } };
    const api = rest(options), tools = mcp(options);
    const request = (path: string, method = 'GET', body?: string, headers = {}) => new Request('https://app.test' + path, { method, body, headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers } });
    const restCall = async (props: unknown, path = '/api/views/public-records', raw?: string, headers = {}) => api(request(path, raw === undefined ? 'GET' : 'POST', raw, headers), {}, { props: { mantle: await pinned(props, targets, `rest:${raw === undefined ? 'GET' : 'POST'} ${path}`) } });
    const mcpCall = async (props: unknown, name = 'public_records', args = {}, path = '/mcp', headers = {}) => { const raw = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }); const id = name.endsWith('_records') ? 'view:' + name.replace('_', '-') : 'procedure:' + name; return tools(request(path, 'POST', raw, headers), {}, { props: { mantle: await pinned(props, targets, id) } }); };
    const rpcData = async (response: Response) => { const text = await response.text(); return JSON.parse(text.startsWith('event:') ? text.split('data: ')[1]!.split('\n')[0]! : text); };
    for (const layer of ['admin', 'member'] as const) {
      const props = mantleProps({ layer, user: { id: 'person', role: 'admin', region: ['TW'], stores: ['A'] } });
      const response = await restCall(props); expect(response.status).toBe(200); expect((await response.json()).rows.map((r: any) => r.title)).toEqual(['TWA']);
      expect(authorized!.kind).toBe(layer === 'admin' ? 'host' : 'user'); expect(isAdmin(authorized!)).toBe(layer === 'admin');
      const rpc = await mcpCall(props); expect(rpc.status).toBe(200); expect((await rpcData(rpc)).result.structuredContent.rows.map((r: any) => r.title)).toEqual(['TWA']);
      const adminRpc = await mcpCall(props, 'admin_records', {}, '/mcp/admin'); expect(adminRpc.status).toBe(layer === 'admin' ? 200 : 403); if (layer === 'admin') await rpcData(adminRpc);
      const denied = await restCall({ ...props, layer: 'member' }, '/api/write', JSON.stringify({ id: 'x', version: 1, title: 'denied' })); expect(denied.status).toBe(403); expect((await denied.json()).error.code).toBe('AUTH_DENIED');
    }
    const before = acquired;
    for (const props of invalidProps()) for (const call of [restCall, mcpCall]) { const r = await call(props); expect(r.status).toBe(412); expect((await r.json()).error.code).toBe('HOST_CONTRACT'); }
    expect(acquired).toBe(before);
    for (const region of [undefined, []]) for (const call of [restCall, mcpCall]) {
      const user = { ...mantleProps().user }; if (region) user.region = region; else delete user.region;
      const r = await call(mantleProps({ user })); if (r.status >= 400) { expect(r.status).toBe(412); expect((await r.json()).error).toMatchObject({ code: 'HOST_CONTRACT', field: 'region' }); } else { const result = (await rpcData(r)).result; expect(result.isError).toBe(true); expect(result.structuredContent.diagnostics[0]).toMatchObject({ code: 'HOST_CONTRACT', field: 'region' }); }
    }
    const constructorField = await restCall(mantleProps({ layer: 'member', user: { ...mantleProps().user, constructor: 'unused' } }));
    expect(constructorField.status).toBe(200);
    const snapshot = mantleProps({ authenticatedAs: 'snapshot' });
    expect((await restCall(snapshot)).status).toBe(200);
    const snapshotRpc = await mcpCall(snapshot); expect(snapshotRpc.status).toBe(200); await rpcData(snapshotRpc);
    for (const r of [await restCall(snapshot, '/api/write', '{}'), await mcpCall(snapshot, 'write'), await restCall(snapshot, '/api/touch', '{}'), await mcpCall(snapshot, 'touch')]) { expect(r.status).toBe(403); expect((await r.json()).error.code).toBe('STALE_CALLER'); }
    expect(touched).toBe(0);
    expect((await restCall(mantleProps(), '/api/touch', '{}')).status).toBe(200); expect(touched).toBe(1);
    const all = mantleProps({ user: { ...mantleProps().user, region: { all: true } } });
    expect((await (await restCall(all)).json()).rows.map((r: any) => r.title)).toEqual(['JPA', 'TWA']);
    const own = db.query("SELECT id,version FROM records WHERE region='TW' AND store='A'").get() as { id: string; version: number };
    const input = { ...own, title: 'updated' };
    const stale = { code: 'STALE_CALLER', status: 403 };
    for (const layer of ['admin', 'member'] as const) {
      const caller = hostCaller(mantleProps({ authenticatedAs: 'snapshot', layer }), { tenant: 'example', fields: {...fields, stores: {type: 'string', multiple: true}} });
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
        expect((await tools(transportRequest, {}, { props: { mantle: await pinned(mantleProps(), targets, path === '/mcp/admin' ? 'procedure:write' : 'procedure:touch') } })).status).toBe(status);
      }
    }
    for (const malformed of [[rpc], { ...rpc, jsonrpc: '1.0' }, { ...rpc, id: {} }, { ...rpc, params: [] }]) expect((await tools(request('/mcp/admin', 'POST', JSON.stringify(malformed)), {}, { props: { mantle: await pinned(mantleProps(), targets, 'procedure:write') } })).status).toBe(400);
    expect(acquired).toBe(beforeTransport); expect(touched).toBe(1);
    expect(db.query('SELECT title,version FROM records WHERE id=?').get(own.id)).toEqual({ title: 'TWA', version: own.version });
    const foreignSession = await restCall(mantleProps({ credential: 'session' }), '/api/write', JSON.stringify(input), { origin: 'https://foreign.test' }); expect(foreignSession.status).toBe(403);
    expect((await restCall(mantleProps(), '/api/write', JSON.stringify(input))).status).toBe(200);
    expect(db.query('SELECT title FROM records WHERE id=?').get(own.id)).toEqual({ title: 'updated' });
    const current = db.query('SELECT version FROM records WHERE id=?').get(own.id) as { version: number };
    const mcpWrite = await mcpCall(mantleProps(), 'write', { ...input, version: current.version }, '/mcp/admin');
    expect(mcpWrite.status).toBe(200); expect((await rpcData(mcpWrite)).result.isError).toBeUndefined();
    expect(db.query('SELECT version,title FROM records WHERE id=?').get(own.id)).toEqual({ version: current.version + 1, title: 'updated' });
    const malformedRpc = await tools(request('/mcp', 'POST', JSON.stringify({ method: 'tools/call', params: { name: 'touch' } })), {}, { props: { mantle: await pinned(mantleProps(), targets, 'procedure:touch') } }); expect(malformedRpc.status).toBe(400); expect(touched).toBe(1);
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
      const ctx = { props: { mantle: await pinned(mantleProps({ layer, authenticatedAs: 'snapshot' }), targets, 'view:public-records') } };
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
    const dryWeb = await site.fetch(request('/records.md'), {}, { props: { mantle: await pinned(mantleProps({ dryRun: true }), targets, 'view:public-records') } }); expect(dryWeb.status).toBe(200); expect((await dryWeb.json()).dryRun).toBe(true);
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
    const snapshot = hostCaller(mantleProps({ authenticatedAs: 'snapshot' }), { tenant: 'example', fields: {...fields, stores: {type: 'string', multiple: true}} });
    for (const verb of ['publish', 'unpublish', 'archive']) {
      const transition = (await import(resolve(dir, 'procedures', 'records.' + verb + '.ts'))).default;
      await expect(transition(db, snapshot, { id: own.id, expectedVersion: own.version })).rejects.toMatchObject({ code: 'STALE_CALLER', status: 403 });
    }
    expect(db.query('SELECT title,status,version FROM records').get()).toEqual({ title: 'draft', status: 'draft', version: own.version });
  } finally { db.close(); await rm(dir, { recursive: true, force: true }); }
});

test('forwarded pinning, dry runs and access decisions share one boundary', async () => {
  const files = await generateOrThrow('bun-sqlite', [{sourceId:'gateway.yaml',text:gatewaySource + '\n---\n' + JSON.stringify({apiVersion:'cms.mantle.aotter.net/v2',kind:'View',metadata:{name:'restricted-records'},spec:{surface:'public',restrict:{records:"region IN auth.user('region')"},sql:'SELECT id,title FROM records ORDER BY region,store,id'}})}]);
  const dir = await mkdtemp(resolve(import.meta.dir, '.gateway-')), db = new Database(':memory:');
  const events: any[] = []; let acquired = 0, touched = 0, allow = true;
  try {
    await writeGenerated(dir, files); db.exec(files['schema.sql']!);
    const app = await import(resolve(dir,'generated.ts')), {rest} = await import(resolve(dir,'rest.ts')), {mcp} = await import(resolve(dir,'mcp.ts')), {targets} = await import(resolve(dir,'access-targets.ts'));
    const row = await app.store(db,{kind:'system',reason:'fixture'}).collection('records').insert({region:'TW',store:'A',title:'original'});
    const options = {gateway:{tenant:'example'},db:()=>{ acquired++; return db; },handlers:{touch:()=>{ touched++; return {}; }},authorize:()=>allow,onAccess:(e:any)=>{events.push(e);} };
    const api = rest(options), tools = mcp(options);
    const readId = 'rest:GET /api/views/public-records', writeId = 'rest:POST /api/write';
    const raw = JSON.stringify({id:row.id,version:row.version,title:'changed'});
    const call = async (props:unknown,path='/api/views/public-records',body?:string) => {
      const before = events.length;
      const response = await api(new Request('https://app.test'+path,{method:body===undefined?'GET':'POST',body}),{}, {props:{mantle:props}});
      expect(events.length).toBe(before+1); return response;
    };
    expect((await call(undefined)).status).toBe(412); expect(events.at(-1)).toMatchObject({outcome:'error',reason:'HOST_CONTRACT'});
    for (const missing of ['target','targetHash']) {
      const props = {...await pinned(mantleProps(),targets,readId) as any}; delete props[missing];
      const response = await call(props); expect(response.status).toBe(412); expect((await response.json()).error).toMatchObject({code:'HOST_CONTRACT',field:missing}); expect(events.at(-1)).toMatchObject({outcome:'error',reason:'HOST_CONTRACT',field:missing,target:readId});
    }
    for (const [overrides,code] of [[{target:'procedure:write'},'TARGET_MISMATCH'],[{targetHash:'old'},'TARGET_HASH_MISMATCH']] as const) {
      const response = await call({...await pinned(mantleProps(),targets,readId) as any,...overrides}); expect(response.status).toBe(412); expect((await response.json()).error.code).toBe(code); expect(events.at(-1)).toMatchObject({outcome:'error',reason:code});
    }
    const writeProps = await pinned(mantleProps(),targets,writeId) as any;
    const before = acquired;
    const dry = await call({...writeProps,dryRun:true},'/api/write',raw); expect(dry.status).toBe(200);
    const event = (await dry.json()).event; expect(event).toEqual(events.at(-1)); expect(Object.keys(event).sort()).toEqual(['caller','dryRun','outcome','requestId','target','targetHash','v']); expect(event).toMatchObject({dryRun:true,outcome:'allow',caller:{kind:'host',subject:'host:person',layer:'admin'},target:writeId,targetHash:targets[writeId].targetHash});
    expect(acquired).toBe(before); expect(db.query('SELECT title FROM records').get()).toEqual({title:'original'});
    const invalidRaw = JSON.stringify({id:row.id,version:row.version,title:123});
    const invalidDry = await call(await pinned(mantleProps({dryRun:true}),targets,writeId),'/api/write',invalidRaw);
    expect(invalidDry.status).toBe(400); expect(acquired).toBe(before); expect(events.at(-1)).toMatchObject({outcome:'error',reason:'INPUT_VALIDATION_FAILED',dryRun:true});
    const ref = await pinned(mantleProps({dryRun:true}),targets,'rest:POST /api/touch');
    const unsupported = await call(ref,'/api/touch','{}'); expect(unsupported.status).toBe(412); expect((await unsupported.json()).error.code).toBe('DRY_RUN_UNSUPPORTED'); expect(touched).toBe(0);
    expect((await call(await pinned(mantleProps(),targets,readId))).status).toBe(200); expect(events.at(-1)).toMatchObject({outcome:'allow'});
    const member = mantleProps({layer:'member',target:undefined,targetHash:undefined}); delete (member as any).target; delete (member as any).targetHash;
    expect((await call(member)).status).toBe(200); expect(events.at(-1)).toMatchObject({caller:{kind:'user',layer:'member'}});
    expect((await call({...member,target:'view:wrong'})).status).toBe(412);
    const all = await pinned(mantleProps({user:{...mantleProps().user,region:{all:true}}}),targets,readId);
    expect((await call(all)).status).toBe(200);
    const restricted = await pinned(mantleProps({dryRun:true,user:{...mantleProps().user,region:{all:true}}}),targets,'rest:GET /api/views/restricted-records');
    expect((await call(restricted,'/api/views/restricted-records')).status).toBe(403); expect(events.at(-1)).toMatchObject({outcome:'deny',reason:'AUTH_DENIED'});
    allow = false; expect((await call(await pinned(mantleProps(),targets,readId))).status).toBe(403); expect(events.at(-1)).toMatchObject({outcome:'deny',reason:'AUTH_DENIED'}); allow = true;
    expect((await call({...writeProps,authenticatedAs:'snapshot'},'/api/write',raw)).status).toBe(403); expect(events.at(-1)).toMatchObject({outcome:'deny',reason:'STALE_CALLER'});
    const throwing = rest({...options,onAccess:()=>{throw Error('listener');}});
    expect((await throwing(new Request('https://app.test/api/views/public-records'),{}, {props:{mantle:await pinned(mantleProps(),targets,readId)}})).status).toBe(200);
    const unresolved = rest({...options,onAccess:()=>new Promise<void>(()=>{})});
    expect((await unresolved(new Request('https://app.test/api/views/public-records'),{}, {props:{mantle:await pinned(mantleProps(),targets,readId)}})).status).toBe(200);
    const {nativeRest} = await import('../src/kernel/rest.js');
    const uploadId = 'rest:POST /upload', uploadTargets = {[uploadId]:{targetHash:'upload-hash',readOnly:false,opaque:true,requires:{all:['ctx.admin']}}};
    let uploads = 0; const uploadBody = 'bound\0bytes';
    const upload = nativeRest([{method:'POST',id:uploadId,pattern:/^\/upload$/,rawBody:true,handle:async request=>{uploads++; return {body:await request.text()};}}], {...options,accessTargets:async()=>uploadTargets});
    const uploadProps = await pinned(mantleProps({target:uploadId,targetHash:'upload-hash'}),uploadTargets,uploadId);
    const uploadRequest = () => new Request('https://app.test/upload',{method:'POST',body:uploadBody});
    const uploaded = await upload(uploadRequest(),{}, {props:{mantle:uploadProps}}); expect(uploaded!.status).toBe(200); expect(await uploaded!.json()).toEqual({body:uploadBody});
    const uploadDry = await upload(uploadRequest(),{}, {props:{mantle:{...uploadProps as any,dryRun:true}}}); expect(uploadDry!.status).toBe(412); expect(await uploadDry!.json()).toMatchObject({error:{code:'DRY_RUN_UNSUPPORTED'}}); expect(uploads).toBe(1);
    const noGateway = rest({...options,gateway:undefined,caller:()=>userCaller(mantleProps().user,{fields:{...fields,stores:{type:'string',multiple:true}}})});
    const beforeLocal = events.length; expect((await noGateway(new Request('https://app.test/api/views/public-records'),{})).status).toBe(200); expect(events.length).toBe(beforeLocal);
    const rpc = async (method:string,params?:unknown,props=mantleProps()) => { const body=JSON.stringify({jsonrpc:'2.0',id:1,method,params}); return tools(new Request('https://app.test/mcp',{method:'POST',body,headers:{'content-type':'application/json',accept:'application/json, text/event-stream'}}),{}, {props:{mantle:await pinned(props,targets,method==='tools/call'?'procedure:write':'view:public-records')}}); };
    const listed = await rpc('tools/list'); expect(listed.status).toBe(403); expect((await listed.json()).error.code).toBe('AUTH_DENIED'); expect(events.at(-1)).toMatchObject({outcome:'deny',reason:'AUTH_DENIED'});
    const missingRpc = await rpc('tools/call',{name:'missing',arguments:{}}); await missingRpc.text(); expect(events.at(-1)).toMatchObject({outcome:'error',reason:'INPUT_VALIDATION_FAILED'});
    const rpcDry = await rpc('tools/call',{name:'write',arguments:JSON.parse(raw)},mantleProps({dryRun:true})); expect(rpcDry.status).toBe(200); const dryRpc = await rpcDry.text(); const dryData = JSON.parse(dryRpc.startsWith('event:') ? dryRpc.split('data: ')[1]!.split('\n')[0]! : dryRpc).result.structuredContent; expect(dryData.event).toEqual(events.at(-1)); expect(db.query('SELECT title FROM records').get()).toEqual({title:'original'});
    expect((await call(writeProps,'/api/write',raw)).status).toBe(200); expect(db.query('SELECT title FROM records').get()).toEqual({title:'changed'});
  } finally {db.close(); await rm(dir,{recursive:true,force:true});}
});
