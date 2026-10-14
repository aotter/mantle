import type { HostProps } from '../src/kernel/host-caller.js';
const manifest = (kind: string, name: string, spec: object) => JSON.stringify({ apiVersion: 'cms.mantle.aotter.net/v2', kind, metadata: { name }, spec });
export const gatewaySource = [
  manifest('Schema', 'records', { title: 'Records', lifecycle: 'operational', scope: "region IN auth.user('region') AND store IN auth.user('stores')", indexes: [['region', 'store', 'id']], schema: { type: 'object', required: ['region', 'store', 'title'], properties: { region: { type: 'string', enum: ['TW', 'JP'] }, store: { type: 'string' }, title: { type: 'string' } } } }),
  ...['public', 'admin'].map(surface => manifest('View', surface + '-records', { surface, sql: 'SELECT id,region,store,title FROM records ORDER BY region,store,id' })),
  manifest('Procedure', 'write', { requires: { auth: { all: ['ctx.admin'] } }, input: { type: 'object', required: ['id', 'version', 'title'], properties: { id: { type: 'string' }, version: { type: 'integer' }, title: { type: 'string' } }, additionalProperties: false }, output: { type: 'object' }, handler: { sql: 'UPDATE records SET title=input.title WHERE id=input.id AND version=input.version RETURNING id,title' } }),
  manifest('Procedure', 'touch', { requires: { auth: { all: ['ctx.user'] } }, input: { type: 'object', additionalProperties: false }, output: { type: 'object' }, handler: { ref: 'app.touch' } }),
  ...['write', 'touch'].flatMap(name => [
    manifest('Trigger', name + '-http', { source: { kind: 'http', method: 'POST', path: '/api/' + name }, target: { procedure: name } }),
    ...['public', 'admin'].map(surface => manifest('Trigger', name + '-' + surface, { source: { kind: 'mcp', surface }, target: { procedure: name } })),
  ]),
].join('\n---\n');
export const mantleProps = (overrides: Partial<HostProps> = {}): HostProps => ({ v: 1, tenant: 'example', layer: 'admin', user: { id: 'person', role: 'editor', region: ['TW'], stores: ['A'] }, authenticatedAs: 'fresh', credential: 'oauth', requestId: 'request-1', target: 'fixture', targetHash: 'fixture', ...overrides });
export const invalidProps = () => [null, {}, { ...mantleProps(), v: 2 }, mantleProps({ tenant: 'other' }), { ...mantleProps(), layer: 'owner' }, { ...mantleProps(), requestId: '' }, { ...mantleProps(), user: { id: 'person', region: true } }];

/** Bind fixture requests using the exact generated report and raw bytes. */
export async function pinned(props: unknown, targets: Record<string, {targetHash: string}>, id: string, body = "") {
  if (!props || typeof props !== 'object') return props;
  const p = props as HostProps;
  if (p.layer === 'member' && p.target === undefined && p.targetHash === undefined) return props;
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body)));
  return {...p, target: !p.target || p.target === 'fixture' ? id : p.target, targetHash: !p.targetHash || p.targetHash === 'fixture' ? targets[id]?.targetHash ?? 'unknown' : p.targetHash, bodyDigest: p.bodyDigest ?? btoa(String.fromCharCode(...digest)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')};
}
