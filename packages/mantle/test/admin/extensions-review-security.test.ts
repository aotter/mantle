import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { createAdminSurface } from '../../src/admin/createAdminSurface.js';
import { validateAdminExtensions, type AdminExtension } from '../../src/admin/extensions.js';
import { withCaller } from '../../src/core/withCaller.js';

it('review: real surface rejects invalid credentials, lower roles, invalid targets and cross-site writes', async () => {
  const calls: string[] = [];
  let reads = 0;
  const code = 'export default {};';
  const ext: AdminExtension = {
    apiVersion: 1, id: 'guard', title: 'Guard', source: () => { reads++; return code; },
    contributes: {
      pages: [{ id: 'page', title: 'Page', role: 'editor' }],
      settings: [{ id: 'config', title: 'Config', role: 'owner', schema: { type: 'object', properties: { enabled: { type: 'boolean' } } } }],
      actions: [{ id: 'run', title: 'Run', role: 'owner', target: 'record/v1', presentation: 'run', when: { schema: ['posts'] } }],
    },
    handlers: {
      api: () => { calls.push('api'); return Response.json({ ok: true }); },
      settings: { config: { load: () => { calls.push('load'); return {}; }, save: () => { calls.push('save'); } } },
      actions: { run: { run: () => { calls.push('run'); } } },
    },
  };
  const surface = createAdminSurface({ plan: { schemas: {}, views: {}, procedures: {}, triggers: {} } } as never, {
    basePath: '/admin', extensions: [ext],
    assets: () => new Response('<html><head><base href="/admin/"></head></html>', { headers: { 'content-type': 'text/html' } }),
  });
  const caller = (role: string, credential = 'session') => ({ kind: 'user', subject: role, role, credential });
  const ask = (path: string, who: unknown, method = 'GET', body?: unknown, headers: Record<string, string> = {}) => withCaller(async () => ({ caller: who } as never), surface)(new Request(`https://local.test/admin/${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
  for (const [who, status] of [[{ kind: 'anonymous' }, 401], [caller('owner', 'oauth'), 403], [caller('owner', 'api-key'), 403], [caller(null as never), 403], [caller('contributor'), 403]] as const) {
    for (const path of ['api/x/guard/api/secret', 'api/x/guard/settings/config', 'extensions/guard.js']) expect([path, (await ask(path, who)).status]).toEqual([path, status]);
  }
  expect(calls).toEqual([]);
  expect(reads).toBe(0);
  expect((await ask('api/x/guard/settings/config', caller('editor'))).status).toBe(403);
  expect((await ask('api/x/guard/api/secret', caller('editor'))).status).toBe(200);
  calls.length = 0;
  for (const headers of [{}, { origin: 'https://evil.test' }, { 'sec-fetch-site': 'cross-site' }, { origin: 'https://local.test', 'sec-fetch-site': 'same-site' }]) {
    for (const [path, method, body] of [['api/x/guard/api/secret', 'POST', {}], ['api/x/guard/actions/run', 'POST', { record: { schema: 'posts', id: 'p' } }], ['api/x/guard/settings/config', 'PATCH', { value: { enabled: true } }]] as const) expect((await ask(path, caller('owner'), method, body, headers)).status).toBe(403);
  }
  expect(calls).toEqual([]);
  for (const body of [{ record: { schema: 'other', id: 'p' } }, { record: { schema: 'posts', id: '' } }, { selection: { schema: 'posts', ids: ['p'] } }]) expect([400, 404]).toContain((await ask('api/x/guard/actions/run', caller('owner'), 'POST', body, { origin: 'https://local.test' })).status);
  expect(calls).toEqual([]);
  expect((await ask('api/x/guard/actions/run', caller('owner'), 'POST', { record: { schema: 'posts', id: 'p' } }, { origin: 'https://local.test' })).status).toBe(200);
  expect(calls).toEqual(['run']);
  const html = await (await ask('', { kind: 'anonymous' })).text();
  expect(html).toContain(`sha384-${createHash('sha384').update(code).digest('base64')}`);
  expect(await (await ask('extensions/guard.js', caller('editor'))).text()).toBe(code);
  expect(reads).toBe(1);
  for (const module of ['https://evil.test/a.js', '//evil.test/a.js', '/\\evil.test/a.js']) expect(() => validateAdminExtensions([{ ...ext, source: undefined, module }])).toThrow();
});
