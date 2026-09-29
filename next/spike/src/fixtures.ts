// Shared fixtures: Schemas, two owners' rows (o1 is the caller, o2 the other owner), rows that are
// expired (`e*`) or unpublished, and a helper that stands a fresh local D1 up with all of it.
import { LocalD1 } from './d1.ts';
import type { Schemas } from './types.ts';
import { storageDdl } from './storage.ts';
import { encodeTimestamptz } from './codec.ts';
import type { Site, Hooks, Runtime } from './exec.ts';
import { lower } from './lower.ts';
import type { Program } from './exec.ts';

export const NOW = encodeTimestamptz('2026-09-29T00:00:00Z'); // microseconds
export const caller = (input: Record<string, unknown> = {}, uid = 'o1'): Runtime => ({ uid, now: NOW, input });

export const schemas: Schemas = {
  items: { scope: 'owner', ttl: 'expires_at', fields: { name: 'text', cat: 'text', stock: 'integer', tags: 'json', note: 'text' }, checks: ['stock >= 0'] },
  requisitions: { scope: 'owner', fields: { item_id: 'text', qty: 'integer', state: 'text' } },
  orders: { scope: 'owner', fields: { item_id: 'text', qty: 'integer', total: 'numeric(12,2)' } },
  settings: { scope: 'owner', fields: { key: 'text', value: 'text' }, unique: [['key']] },
  posts: { publishing: true, ttl: 'expires_at', fields: { title: 'text', body: 'text' }, search: ['title', 'body'] },
  notes: { scope: 'owner', ttl: 'expires_at', fields: { title: 'text', body: 'text' }, search: ['title', 'body'] },
  places: { scope: 'owner', ttl: 'expires_at', fields: { name: 'text', loc: 'geo' } },
  events: { scope: 'owner', fields: { title: 'text', at: 'timestamptz', day: 'date', amount: 'numeric(12,2)', qty: 'integer' } },
};

const FUTURE = NOW + 1_000_000_000_000;
const EXPIRED = 1;
export const seed = [
  `INSERT INTO items (id, owner, created_at, expires_at, name, cat, stock, tags, note) VALUES
    ('a','o1',0,NULL,'apple','x',5,'["red","big"]',NULL), ('b','o1',0,NULL,'berry','x',2,'["blue"]',NULL),
    ('c','o1',0,${FUTURE},'cherry','y',9,'["red"]','nc'), ('d','o1',0,NULL,'date','x',7,'["red"]','nd'),
    ('e1','o1',0,${EXPIRED},'expired','x',100,'["red"]',NULL),
    ('z1','o2',0,NULL,'zeta','x',50,'["red"]',NULL), ('z2','o2',0,NULL,'zulu','y',60,'["red"]',NULL)`,
  `INSERT INTO requisitions (id, owner, created_at, item_id, qty, state) VALUES ('r1','o1',0,'a',2,'pending'), ('r2','o1',0,'b',1,'pending'), ('rz','o2',0,'z1',1,'pending')`,
  `INSERT INTO orders (id, owner, created_at, item_id, qty, total) VALUES
    ('oa','o1',0,'a',3,1050), ('ob','o1',0,'a',1,350), ('oe','o1',0,'e1',9,900), ('oz','o2',0,'a',99,9900), ('oz2','o2',0,'z1',5,500)`,
  `INSERT INTO settings (id, owner, created_at, key, value) VALUES ('sz','o2',0,'theme','dark'), ('s1','o1',0,'theme','dark')`,
];

export async function boot(extraSeed: string[] = [], only?: string[]): Promise<{ d1: LocalD1; schemas: Schemas }> {
  const d1 = await LocalD1.create();
  const s = only ? Object.fromEntries(Object.entries(schemas).filter(([k]) => only.includes(k))) : schemas;
  await d1.exec(storageDdl(s));
  await d1.exec([...seed.filter((q) => !only || only.some((t) => q.includes(`INTO ${t} `))), ...extraSeed]);
  return { d1, schemas: s };
}

export const site = (b: { d1: LocalD1; schemas: Schemas }, hooks?: Hooks): Site => ({ ...b, hooks });

/** SQL text -> a Program, going through the CLI path (parse, validate with offsets, strip). */
export async function program(kind: 'view' | 'procedure', sql: string, inputs: Record<string, string> = {}, s: Schemas = schemas): Promise<Program> {
  return { kind, inputs, ir: (await lower(sql, { schemas: s, inputs, kind })).stmts };
}
