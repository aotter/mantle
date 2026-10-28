/** Shared by the Core and Admin conformance tests of describe's matchTarget: the example apps and a probe through a real router. */
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describeApp, type AppDescription } from '../dist/domain/describe/index.js';
import { compilePlan, postgresCompiler, sqliteCompiler } from '../src/build/compiler.js';

const root = resolve(import.meta.dir, '../../..'), fixtures = resolve(import.meta.dir, 'apps');
const manifest = (kind: string, name: string, spec: object) => JSON.stringify({ apiVersion: 'cms.mantle.aotter.net/v2', kind, metadata: { name }, spec });
// Overlapping routes: the router's precedence, not manifest order, decides; `{kind}/latest` is declared first on purpose.
export const precedence = [
  manifest('Schema', 'items', { title: 'Items', lifecycle: 'operational', schema: { type: 'object', required: ['title'], properties: { title: { type: 'string' } } } }),
  manifest('View', 'feed', { surface: 'public', sql: 'SELECT id, title FROM items ORDER BY id' }),
  ...[['latest', 'POST', '/api/{kind}/latest'], ['item', 'POST', '/api/items/{id}'], ['export', 'POST', '/api/items/export'], ['named', 'POST', '/api/views/{name}'], ['save', 'PATCH', '/api/items/{id}'], ['pair', 'POST', '/api/{kind}/{id}']].flatMap(([name, method, path]) => [
    manifest('Procedure', name!, { input: { type: 'object', properties: Object.fromEntries([...path!.matchAll(/\{(\w+)\}/g)].map(([, key]) => [key, { type: 'string' }])) }, output: { type: 'object' }, handler: { ref: 'app.' + name } }),
    manifest('Trigger', name + '-http', { source: { kind: 'http', method, path }, target: { procedure: name } }),
  ]),
  manifest('Trigger', 'item-mcp', { source: { kind: 'mcp', surface: 'admin' }, target: { procedure: 'item' } }),
].join('\n---\n');

export async function apps(): Promise<[string, { sourceId: string; text: string }[]][]> {
  const read = (files: string[]) => Promise.all(files.map(async file => ({ sourceId: file, text: await readFile(file, 'utf8') })));
  const examples = resolve(root, 'docs/examples');
  const list: [string, string[]][] = [
    ...['club-events', 'purchasing', 'recipes', 'reference-service'].map(name => [name, []] as [string, string[]]),
    ['frontend-mcp-app', [resolve(examples, 'frontend-mcp-app/manifest.yaml')]], ['generated-web', [resolve(examples, 'generated-web/posts.yaml')]],
    // Fixtures that compile alone; the others extend a sibling manifest.
    ...['orders', 'paging', 'publishing', 'purchase', 'rest', 'revisions', 'search', 'sql-patterns', 'store-extra', 'surfaces', 'translations', 'user-fields'].map(name => [name, [resolve(fixtures, name + '.yaml')]] as [string, string[]]),
  ];
  for (const entry of list) if (!entry[1].length) entry[1] = (await readdir(resolve(examples, entry[0], 'manifests'))).map(file => resolve(examples, entry[0], 'manifests', file));
  return [['precedence', [{ sourceId: 'precedence.yaml', text: precedence }]], ...await Promise.all(list.map(async ([name, files]) => [name, await read(files)] as [string, { sourceId: string; text: string }[]]))];
}

/** One request through the generated router in gateway mode, pinned to a target nothing has: the router resolves its target, then refuses the pin. */
export function prober(serve: (request: Request, env: unknown, ctx: unknown) => Promise<Response | undefined>, events: { target: string; reason?: string }[], props: object) {
  return async (request: Request): Promise<string | null> => {
    events.length = 0;
    await serve(request, {}, { props: { mantle: props } });
    for (let i = 0; i < 3; i++) await null; // onAccess is queued as a microtask after the decision
    return events.find(event => event.reason === 'TARGET_MISMATCH')?.target ?? null;
  };
}

// The id's template with sample values, and the forms of it the routers accept or refuse.
export const fill = (template: string, value = 'abc') => template.replace(/:[^/]+/g, value);
const encodeLiteral = (template: string) => template.replace(/\/([a-z])([^/]*)$/, (_, first: string, rest: string) => `/%${first.charCodeAt(0).toString(16)}${rest}`);
/** Request paths for a template: the forms the routers accept and refuse. */
export const variants = (template: string) => [fill(template), fill(template) + '/', fill(encodeLiteral(template)), fill(template, 'a%20b'), fill(template, 'caf%C3%A9'), fill(template, 'a%2Fb'),
  fill(template).replace('/', '//'), fill(template) + '//', fill(template).toUpperCase(), fill(template) + '/extra', fill(template, '%zz'), fill(template, '')];

/** The app's generation target and exactly the JSON `mantle describe` prints for it. */
export async function describeOf(name: string, sources: { sourceId: string; text: string }[]) {
  const target = name === 'rest' ? 'bun-postgres' as const : 'bun-sqlite' as const;
  const compiled = await compilePlan({ sources }, target === 'bun-postgres' ? postgresCompiler : sqliteCompiler, 'operational');
  if (!compiled.ok) throw Error(name + JSON.stringify(compiled.diagnostics));
  return { target, describe: JSON.parse(JSON.stringify(await describeApp(compiled.plan))) as AppDescription };
}
/** A parameterized template filled with each literal segment of a surface's templates, so requests reach overlapping routes. */
export const overlaps = (template: string, literals: Set<string>) => template.includes(':') ? [...literals].map(value => fill(template, value)) : [];
/** Literal segments of the describe templates of one surface. */
export const literalsOf = (describe: AppDescription, prefix: string) => new Set(describe.targets.flatMap(t => t._meta.id.startsWith(prefix) ? (t._meta.id.split(' ')[1] ?? '').split('/').filter(s => s && !s.startsWith(':')) : []));
