/** describe's matchTarget against the generated routers: every route of the example apps resolves to the same target. */
import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describeApp, matchTarget } from '../dist/domain/describe/index.js';
import { compilePlan, sqliteCompiler } from '../src/build/compiler.js';
import { generateFromSources } from '../src/infrastructure/generate.js';
import { writeGenerated } from './apps/link.js';
import { mantleProps } from './gateway-fixture.js';
import { apps, describeOf, fill, literalsOf, overlaps, precedence, prober, variants } from './match-target-fixture.js';

test('matchTarget resolves what the generated REST and MCP routers resolve, for every route of the example apps', async () => {
  const counts: Record<string, { rest: number; mcp: number }> = {}, served: Record<string, Set<string>> = {};
  for (const [name, sources] of await apps()) {
    const { target, describe } = await describeOf(name, sources);
    const generated = await generateFromSources({ target, sources: { sources }, site: { media: { purposes: [{ name: 'cover', required: ['png'], maxBytes: { 'image/png': 100 } }] } } });
    if (!generated.ok) throw Error(name + JSON.stringify(generated.diagnostics));
    const dir = await mkdtemp(resolve(import.meta.dir, '.match-'));
    try {
      await writeGenerated(dir, generated.files);
      const events: { target: string; reason?: string }[] = [];
      const user = Object.fromEntries(Object.keys(describe.access).map(field => [field, { all: true }]));
      const props = mantleProps({ user: { id: 'person', role: 'admin', ...user }, target: 'probe', targetHash: 'probe' });
      const options = { gateway: { tenant: 'example' }, onAccess: (event: any) => { events.push(event); }, db: () => { throw Error('No database'); }, handlers: {}, media: () => ({}) };
      const count = counts[name] = { rest: 0, mcp: 0 }, tools = served[name] = new Set<string>();

      const rest = prober((await import(resolve(dir, 'rest.ts'))).rest(options), events, props);
      const ids = describe.targets.map(t => t._meta.id).filter(id => id.startsWith('rest:')), literals = literalsOf(describe, 'rest:');
      for (const id of ids) {
        const [method, template] = id.slice(5).split(' ') as [string, string];
        count.rest++;
        expect(await rest(new Request('https://app.test' + fill(template), { method }))).toBe(id);
        for (const [path, verbs] of [...variants(template).map(path => [path, [method, method.toLowerCase(), 'HEAD', 'PUT', 'DELETE', 'OPTIONS']] as const), ...overlaps(template, literals).map(path => [path, [method]] as const)]) for (const verb of verbs) {
          const request = new Request('https://app.test' + path, { method: verb, body: ['GET', 'HEAD'].includes(verb.toUpperCase()) ? undefined : '{}' });
          expect([id, path, verb, matchTarget(describe, { surface: 'rest', method: request.method, path: new URL(request.url).pathname })?.id ?? null]).toEqual([id, path, verb, await rest(request)]);
        }
      }
      for (const path of ['/api', '/api/missing', '/api/views/missing', '/other', '/', '/api/views/', '/api/%zz'])
        expect(matchTarget(describe, { surface: 'rest', method: 'GET', path }) ?? null).toBe(await rest(new Request('https://app.test' + path)) as null);

      if (!generated.files['mcp.ts']) continue;
      const mcp = prober((await import(resolve(dir, 'mcp.ts'))).mcp(options), events, props);
      const call = (path: string, tool: string) => new Request('https://app.test' + path, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: tool, arguments: {} } }) });
      for (const tool of [...new Set(describe.targets.map(t => t.name)), 'missing_tool', 'view:posts', '']) for (const path of ['/mcp', '/mcp/admin', '/mcp/admin/', '/mcp/other']) {
        const resolved = await mcp(call(path, tool));
        if (resolved) count.mcp = tools.add(resolved).size;
        expect([tool, path, matchTarget(describe, { surface: 'mcp', tool, path })?.id ?? null]).toEqual([tool, path, resolved]);
        // Without the endpoint path, a name both endpoints serve as the same target still resolves.
        if (resolved) expect(matchTarget(describe, { surface: 'mcp', tool })?.id).toBe(resolved);
      }
    } finally { await rm(dir, { recursive: true, force: true }); }
  }
  // Every app contributes; the synthetic precedence app pins the overlaps.
  expect(Object.values(counts).reduce((n, c) => n + c.rest, 0)).toBeGreaterThan(20);
  expect(Object.values(counts).reduce((n, c) => n + c.mcp, 0)).toBeGreaterThan(20);
  console.log(JSON.stringify(counts));
}, 120_000);

test('REST precedence is the router order, not manifest order or parameter count alone', async () => {
  const compiled = await compilePlan({ sources: [{ sourceId: 'precedence.yaml', text: precedence }] }, sqliteCompiler, 'operational');
  if (!compiled.ok) throw Error(JSON.stringify(compiled.diagnostics));
  const describe = await describeApp(compiled.plan);
  const id = (method: string, path: string) => matchTarget(describe, { surface: 'rest', method, path })?.id ?? null;
  expect(id('POST', '/api/items/export')).toBe('rest:POST /api/items/export');
  expect(id('POST', '/api/items/latest')).toBe('rest:POST /api/items/:id');
  expect(id('POST', '/api/things/latest')).toBe('rest:POST /api/:kind/latest');
  expect(id('POST', '/api/things/x')).toBe('rest:POST /api/:kind/:id');
  expect(id('GET', '/api/views/feed')).toBe('rest:GET /api/views/feed');
  expect(id('POST', '/api/views/feed')).toBe('rest:POST /api/views/:name');
  expect(id('HEAD', '/api/views/feed/')).toBe('rest:GET /api/views/feed');
  expect(id('HEAD', '/api/views/other')).toBe(null);
  expect(id('GET', '/api/views/%66eed')).toBe('rest:GET /api/views/feed');
  expect(id('patch', '/api/items/x')).toBe(null);
  expect(id('PATCH', '/api/items/x')).toBe('rest:PATCH /api/items/:id');
  expect(id('post', '/api/items/x')).toBe('rest:POST /api/items/:id');
  expect(id('POST', '/api//items/x')).toBe(null);
  expect(matchTarget(describe, { surface: 'mcp', tool: 'item' })?.id).toBe('procedure:item');
  expect(matchTarget(describe, { surface: 'mcp', tool: 'item', path: '/mcp' })).toBe(null);
  expect(matchTarget(describe, { surface: 'mcp', tool: 'create_media_upload', path: '/mcp/admin' })?.id).toBe('admin:tool:create_media_upload');
  expect(matchTarget(describe, { surface: 'admin', method: 'GET', path: '/admin/api/entries/export' })?.id).toBe('admin:GET /entries/export');
  expect(matchTarget(describe, { surface: 'admin', method: 'GET', path: '/admin/api/entries/abc' })?.id).toBe('admin:GET /entries/:id');
  expect(matchTarget(describe, { surface: 'admin', method: 'GET', path: '/entries/abc' })).toBe(null);
});

test('only whole {name} segments are parameters; Trigger paths that describe could not tell apart are refused', async () => {
  const { routeSource } = await import('../src/kernel/rest.js');
  const literal = new RegExp(routeSource('/api/items/:id').source);
  expect(literal.test('/api/items/%3Aid')).toBe(true);
  expect(literal.test('/api/items/abc')).toBe(false);
  expect(routeSource('/api/items/:id').keys).toEqual([]);
  expect(routeSource('/x/{rest*}', '/admin/api', true)).toEqual({ source: '^/admin/api/x/(.*)/?$', keys: ['rest'] });
  const compile = (paths: [string, string][]) => compilePlan({ sources: [{ sourceId: 'paths.yaml', text: paths.flatMap(([method, path], i) => [
    `apiVersion: cms.mantle.aotter.net/v2\nkind: Procedure\nmetadata: { name: p${i} }\nspec:\n  input: { type: object }\n  output: { type: object }\n  handler: { ref: app.p${i} }`,
    `apiVersion: cms.mantle.aotter.net/v2\nkind: Trigger\nmetadata: { name: p${i}-http }\nspec:\n  source: { kind: http, method: ${method}, path: '${path}' }\n  target: { procedure: p${i} }`]).join('\n---\n') }] }, sqliteCompiler, 'operational');
  const codes = async (paths: [string, string][]) => { const r = await compile(paths); return r.ok ? [] : r.diagnostics.map(d => d.code); };
  for (const path of ['/api/items/:id', '/api/items/a{id}', '/api/items/{id', '/api/items/id}'])
    expect(await codes([['POST', path]])).toContain('TRIGGER_PATH_INVALID');
  expect(await codes([['POST', '/api/{a}/x'], ['POST', '/api/{b}/x']])).toContain('TRIGGER_PATH_COLLISION');
  expect(await codes([['POST', '/api/{a}/x'], ['PATCH', '/api/{b}/x'], ['POST', '/api/items/{id}'], ['POST', '/api/{kind}/latest']])).toEqual([]);
});
