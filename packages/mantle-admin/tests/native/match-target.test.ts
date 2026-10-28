/** describe's matchTarget against the Admin router: every Admin route of the example apps resolves to the same target. */
import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { matchTarget } from '@aotter/mantle/describe';
import { admin } from '../../src/server/index.js';
import { entries } from '../../src/server/entries.js';
import { siteRoutes } from '../../src/server/site.js';
import { webmcpRoutes } from '../../src/server/webmcp.js';
import { writeAdminFixture } from './generated-fixture.js';
import { mantleProps } from '../../../mantle/tests/gateway-fixture.js';
import { apps, describeOf, fill, literalsOf, overlaps, prober, variants } from '../../../mantle/tests/match-target-fixture.js';

// Optional mounts describe lists conservatively; an app without them serves nothing there.
const optional = new Set(['admin:GET /developer/views/:name', 'admin:GET /developer-console', 'admin:GET /collections/:name/statistics']);

test('matchTarget resolves what the Admin router resolves, for every Admin route of the example apps', async () => {
  const { generateFromSources } = await import('../../../mantle/src/infrastructure/generate.js');
  const counts: Record<string, number> = {};
  for (const [name, sources] of await apps()) {
    const { target, describe } = await describeOf(name, sources);
    const generated = await generateFromSources({ target, admin: true, sources: { sources } });
    if (!generated.ok) throw Error(name + JSON.stringify(generated.diagnostics));
    const dir = await mkdtemp(resolve(import.meta.dir, '../.match-'));
    try {
      await writeAdminFixture(dir, generated.files);
      const bindings = (await import(resolve(dir, 'admin-bindings.ts'))).adminBindings({ handlers: {} });
      const tools = generated.files['mcp.ts'] ? (await import(resolve(dir, 'mcp.ts'))).tools : [];
      const events: { target: string; reason?: string }[] = [];
      const options = { gateway: { tenant: 'example' }, onAccess: (event: any) => { events.push(event); }, db: () => { throw Error('No database'); }, handlers: {}, developerViews: bindings.developerViews,
        routes: [...entries(bindings.schemas, bindings.adapter), ...siteRoutes({}), ...webmcpRoutes(bindings.metadata.webmcp, tools, {} as never)] };
      const user = Object.fromEntries(Object.keys(describe.access).map(field => [field, { all: true }]));
      const probe = prober(admin(bindings.metadata, bindings.views, bindings.operations, options as never) as never, events, mantleProps({ user: { id: 'person', role: 'admin', ...user }, target: 'probe', targetHash: 'probe' }));
      const ids = describe.targets.map(t => t._meta.id).filter(id => /^admin:[A-Z]+ /.test(id)), literals = literalsOf(describe, 'admin:');
      let served = 0;
      const unmounted = new Set<string>();
      for (const id of ids) {
        const [method, template] = id.slice(6).split(' ') as [string, string];
        const resolved = await probe(new Request('https://app.test/admin/api' + fill(template), { method, body: method === 'GET' ? undefined : '{}' }));
        if (resolved === null && optional.has(id)) { unmounted.add(id); continue; }
        expect([id, resolved]).toEqual([id, id]);
        served++;
        const verbs = [method, method.toLowerCase(), 'HEAD', 'PUT', 'DELETE', 'OPTIONS'];
        for (const [path, sent] of [...[...variants(template).map(path => '/admin/api' + path), fill(template), '/admin/%61pi' + fill(template), '/admin/api/' + fill(template)].map(path => [path, verbs] as const), ...overlaps(template, literals).map(path => ['/admin/api' + path, [method]] as const)])
          for (const verb of sent) {
            const request = new Request('https://app.test' + path, { method: verb, body: ['GET', 'HEAD'].includes(verb.toUpperCase()) ? undefined : '{}' });
            const routed = await probe(request), matched = matchTarget(describe, { surface: 'admin', method: request.method, path: new URL(request.url).pathname })?.id ?? null;
            if (routed === null && matched !== null && unmounted.has(matched)) continue;
            expect([id, path, verb, matched]).toEqual([id, path, verb, routed]);
          }
      }
      for (const path of ['/admin/api', '/admin/api/', '/admin/api/missing', '/admin/apix/me', '/admin/me', '/admin/api/entries/a/b/c'])
        expect(matchTarget(describe, { surface: 'admin', method: 'GET', path }) ?? null).toBe(await probe(new Request('https://app.test' + path)) as null);
      counts[name] = served;
    } finally { await rm(dir, { recursive: true, force: true }); }
  }
  expect(Object.values(counts).every(n => n >= 30)).toBe(true);
  console.log(JSON.stringify(counts));
}, 180_000);
