import { expect, it } from 'vitest';
import { createAdminSurface } from '../../src/admin/createAdminSurface.js';
import { checkFormValue, checkPlanUiExtensions, formSchemaProblem, planUiExtensionRefs, type AdminExtension } from '../../src/admin/extensions.js';
import { withCaller } from '../../src/core/withCaller.js';

const names = ['constructor', 'hasOwnProperty', 'toString', 'valueOf', '0', '01', '4294967295'];
const schema = { type: 'object', required: names, properties: Object.fromEntries(names.map(name => [name, { type: 'integer', minimum: 1 }])) } as const;
const valid = Object.fromEntries(names.map(name => [name, 2]));
const emptyPlan = { schemas: {}, views: {}, procedures: {}, triggers: {} };
const owner = { kind: 'user', subject: 'review-owner', role: 'owner', credential: 'session' } as const;
const field: AdminExtension = { apiVersion: 1, id: 'host', title: 'Host', module: '/host.js', contributes: { fields: [{ id: 'input', target: 'field.input/v1', optionsSchema: schema }, { id: 'cell', target: 'field.cell/v1' }], panels: [{ id: 'panel', title: 'Panel', role: 'owner', target: 'record.sidebar/v1' }] } };
const optionsPlan = (options: unknown) => ({ ...emptyPlan, schemas: { posts: { name: 'posts', uiSchema: { fields: { title: { widget: 'host/input', options } } } } } }) as never;

function settings(testSchema: typeof schema | { type: 'object'; properties: Record<string, object> }) {
  const saved: unknown[] = [];
  const ext: AdminExtension = { apiVersion: 1, id: 'forms', title: 'Forms', contributes: { settings: [{ id: 'config', title: 'Config', role: 'owner', schema: testSchema }] }, handlers: { settings: { config: { load: () => ({}), save: (_caller, value) => { saved.push(value); return value; } } } } };
  const surface = createAdminSurface({ plan: emptyPlan } as never, { basePath: '/admin', extensions: [ext] });
  const route = withCaller(async () => ({ caller: owner } as never), surface);
  const raw = (body: string) => route(new Request('https://local.test/admin/api/x/forms/settings/config', { method: 'PATCH', headers: { origin: 'https://local.test', 'content-type': 'application/json' }, body }));
  return { saved, raw, patch: (value: unknown) => raw(JSON.stringify({ value })) };
}

it('reserved and numeric keys use own property validation through settings HTTP and options boot validation', async () => {
  expect(formSchemaProblem(schema)).toBeNull();
  const s = settings(schema);
  expect(Object.getPrototypeOf(checkFormValue(schema, valid))).toBeNull();
  expect(checkFormValue(schema, valid)).toEqual({});
  expect(() => checkPlanUiExtensions(optionsPlan(valid), [field])).not.toThrow();
  for (const name of names) {
    const bad = { ...valid, [name]: 'wrong' };
    expect(checkFormValue(schema, bad)).toEqual({ [name]: 'expected an integer' });
    const response = await s.patch(bad);
    expect(response.status).toBe(400);
    expect((await response.json()).error.fields).toEqual({ [name]: 'expected an integer' });
    expect(() => checkPlanUiExtensions(optionsPlan(bad), [field])).toThrow(expect.objectContaining({ diagnostic: expect.objectContaining({ code: 'UI_EXTENSION_OPTIONS', path: `schema:posts/uiSchema/fields/title/widget/${name}` }) }));
    const missing = { ...valid }; delete missing[name];
    expect(checkFormValue(schema, missing)).toEqual({ [name]: 'required' });
    expect((await s.patch(missing)).status).toBe(400);
    expect(checkFormValue(schema, { ...valid, [name]: null })).toEqual({ [name]: 'expected an integer' });
  }
  expect(s.saved).toEqual([]);
  expect((await s.patch(valid)).status).toBe(200);
  expect(s.saved).toEqual([valid]);
});

it('unknown prototype names, own __proto__, inherited values and optional null do not bypass validation', async () => {
  const simple = { type: 'object', properties: { note: { type: 'string' } } } as const;
  const s = settings(simple);
  for (const key of [...names, '__proto__']) {
    const value = JSON.parse(`{"${key}":{"polluted":true}}`);
    expect(checkFormValue(simple, value)).toEqual({ [key]: 'no such field' });
    const response = await s.patch(value);
    expect(response.status).toBe(400);
    expect((await response.json()).error.fields).toEqual({ [key]: 'no such field' });
  }
  expect(checkFormValue(schema, Object.create(valid))).toEqual(Object.fromEntries(names.map(name => [name, 'required'])));
  expect(checkFormValue(simple, { note: null })).toEqual({ note: 'expected a string' });
  expect((await s.patch({ note: null })).status).toBe(400);
  expect(s.saved).toEqual([]);
  expect(Object.hasOwn(Object.prototype, 'polluted')).toBe(false);
});

it('deep values are rejected without recursive traversal and large payloads obey the shared HTTP character cap', async () => {
  const s = settings({ type: 'object', properties: { note: { type: 'string' } } });
  const nested = '['.repeat(12000) + '0' + ']'.repeat(12000);
  const deep = await s.raw('{"value":{"note":' + nested + '}}');
  expect(deep.status).toBe(400);
  expect((await deep.json()).error.fields).toEqual({ note: 'expected a string' });
  const wide = Object.fromEntries(Array.from({ length: 40000 }, (_, i) => [`x${i}`, 0]));
  const wideResponse = await s.patch(wide);
  expect(wideResponse.status).toBe(400);
  expect(Object.keys((await wideResponse.json()).error.fields)).toHaveLength(40000);
  const shell = JSON.stringify({ value: { note: '' } });
  const atLimit = JSON.stringify({ value: { note: 'a'.repeat(1000000 - shell.length) } });
  expect(atLimit.length).toBe(1000000);
  expect((await s.raw(atLimit)).status).toBe(200);
  const tooLarge = await s.raw(atLimit + ' ');
  expect(tooLarge.status).toBe(400);
  expect((await tooLarge.json()).error.message).toContain('larger than 1000000 characters');
  expect(s.saved).toHaveLength(1);
});

it('options use the same validator for null, __proto__, deep and wide input', () => {
  const simpleField: AdminExtension = { ...field, contributes: { fields: [{ id: 'input', target: 'field.input/v1', optionsSchema: { type: 'object', properties: { note: { type: 'string' } } } }] } };
  const nested = JSON.parse('['.repeat(12000) + '0' + ']'.repeat(12000));
  const cases = [null, { note: null }, JSON.parse('{"__proto__":{"polluted":true}}'), { note: nested }, Object.fromEntries(Array.from({ length: 40000 }, (_, i) => [`x${i}`, 0]))];
  for (const options of cases) expect(() => checkPlanUiExtensions(optionsPlan(options), [simpleField])).toThrow(expect.objectContaining({ diagnostic: expect.objectContaining({ code: 'UI_EXTENSION_OPTIONS' }) }));
  expect(() => checkPlanUiExtensions(optionsPlan({ note: 'a'.repeat(1000000) }), [simpleField])).not.toThrow();
});

it('host provenance guard enumerates every supported binding slot; core intentionally accepts host references', () => {
  const plan = {
    ...emptyPlan,
    schemas: { posts: { name: 'posts', uiSchema: { fields: { title: { widget: 'host/input', options: valid }, note: { widget: 'textarea' } }, list: { cells: { title: 'host/cell' } }, panels: ['host/panel'] } } },
    procedures: { update: { uiSchema: { fields: { title: { widget: 'host/input', options: valid } } } } },
    views: { report: { uiSchema: { list: { cells: { title: 'host/cell' } } } } },
  } as never;
  expect(planUiExtensionRefs(plan).map(x => x.path)).toEqual(['schema:posts/uiSchema/fields/title/widget', 'schema:posts/uiSchema/list/cells/title', 'schema:posts/uiSchema/panels', 'procedure:update/uiSchema/fields/title/widget', 'view:report/uiSchema/list/cells/title']);
  expect(() => checkPlanUiExtensions(plan, [field])).not.toThrow();
  const hostIds = new Set(['host']);
  expect(planUiExtensionRefs(plan).filter(x => hostIds.has(x.ref.split('/')[0]!))).toHaveLength(5);
  // Host must run this guard before createAdminSurface; its input is the sealed plan.
  const hostGuard = () => { if (planUiExtensionRefs(plan).some(x => hostIds.has(x.ref.split('/')[0]!))) throw new Error('manifest names host extension'); };
  expect(hostGuard).toThrow('manifest names host extension');
});
