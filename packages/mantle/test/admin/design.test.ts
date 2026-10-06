import { expect, it } from "vitest";
import { createAdminDesignSurface } from "../../src/admin/design.js";
import { developerConsole } from "../../src/admin/developerConsole.js";
import { compilePlan } from "../../src/spec/index.js";

it("draft metadata grants no staff identity and cannot execute or reach the authenticated surface", async () => {
  const compiled = await compilePlan({ sources: [] });
  if (!compiled.ok) throw new Error('Empty plan did not compile');
  const snapshot = developerConsole(compiled.plan);
  const handle = createAdminDesignSurface(snapshot, { origin: 'https://design.test', name: 'My draft' });
  const get = (path: string, method = 'GET') => handle(new Request('https://design.test' + path, { method }));
  expect(await (await get('/admin/api/me')).json()).toMatchObject({ role: null });
  expect(await (await get('/admin/api/developer-console')).json()).toEqual(snapshot);
  for (const [path, method] of [['/admin/api/entries', 'POST'], ['/admin/api/entries', 'GET'], ['/api/auth/sign-out', 'POST'], ['/admin/api/staff', 'GET']]) expect((await get(path!, method!)).status).toBe(403);
  expect((await handle(new Request('https://foreign.test/admin/api/me'))).status).toBe(403);
});
