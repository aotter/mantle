// Shared fixtures: Schemas, two owners' rows (o1 is the caller, o2 the other owner), rows that are
// expired or unpublished, and a helper that stands a fresh local D1 up with all of it.
//
// Every row the caller must never see has an id starting `X_` and text containing `LEAK`, so a probe
// can assert "no result contains LEAK" without knowing what it queried.
import { LocalD1 } from './d1.ts';
import type { Schemas } from './types.ts';
import { storageDdl } from './storage.ts';
import { encodeTimestamptz } from './codec.ts';
import type { Site, Hooks, Runtime, Program } from './exec.ts';
import { lower } from './lower.ts';

export const NOW = encodeTimestamptz('2026-09-29T00:00:00Z'); // microseconds
export const caller = (input: Record<string, unknown> = {}, uid = 'o1'): Runtime => ({ uid, now: NOW, input });

export const schemas: Schemas = {
  items: { scope: 'owner', ttl: 'expires_at', fields: { name: 'text', cat: 'text', stock: 'integer', tags: 'json', note: 'text' }, checks: ['stock >= 0'] },
  requisitions: { scope: 'owner', fields: { item_id: 'text', qty: 'integer', state: 'text' } },
  orders: { scope: 'owner', fields: { item_id: 'text', qty: 'integer', total: 'numeric(12,2)' } },
  settings: { scope: 'owner', fields: { key: 'text', value: 'text' }, unique: [['key']] },
  posts: { publishing: true, ttl: 'expires_at', fields: { title: 'text', body: 'text' }, search: ['title', 'body'] },
  notes: { scope: 'owner', ttl: 'expires_at', fields: { title: 'text', body: 'text' }, search: ['title', 'body'], unique: [['title']] },
  places: { scope: 'owner', ttl: 'expires_at', fields: { name: 'text', loc: 'geo' } },
  events: { scope: 'owner', fields: { title: 'text', at: 'timestamptz', day: 'date', amount: 'numeric(12,2)', qty: 'integer' } },
};

/** a point and places at known distances north of it */
export const CENTER = { lat: 25.033, lng: 121.5654 };
export const METERS_PER_DEGREE_LAT = (2 * Math.PI * 6_371_008.8) / 360;
export const north = (m: number) => CENTER.lat + m / METERS_PER_DEGREE_LAT;

const FUTURE = NOW + 1_000_000_000_000;
const EXPIRED = 1;
export const seed = [
  `INSERT INTO items (id, owner, created_at, expires_at, name, cat, stock, tags, note) VALUES
    ('a','o1',0,NULL,'apple','x',5,'["red","big"]',NULL), ('b','o1',0,NULL,'berry','x',2,'["blue"]',NULL),
    ('c','o1',0,${FUTURE},'cherry','y',9,'["red"]','nc'), ('d','o1',0,NULL,'date','x',7,'["red"]','nd'),
    ('X_e1','o1',0,${EXPIRED},'LEAK-expired','x',100,'["LEAK-tag"]',NULL),
    ('X_z1','o2',0,NULL,'LEAK-zeta','x',50,'["LEAK-tag"]',NULL), ('X_z2','o2',0,NULL,'LEAK-zulu','y',60,'["LEAK-tag"]',NULL)`,
  `INSERT INTO requisitions (id, owner, created_at, item_id, qty, state) VALUES ('r1','o1',0,'a',2,'pending'), ('r2','o1',0,'b',1,'pending'), ('X_rz','o2',0,'X_z1',1,'pending')`,
  `INSERT INTO orders (id, owner, created_at, item_id, qty, total) VALUES
    ('oa','o1',0,'a',3,1050), ('ob','o1',0,'a',1,350), ('oe','o1',0,'X_e1',9,900), ('X_oz','o2',0,'a',99,9900), ('X_oz2','o2',0,'X_z1',5,500)`,
  `INSERT INTO settings (id, owner, created_at, key, value) VALUES ('s1','o1',0,'theme','dark'), ('X_sz','o2',0,'theme','dark'), ('X_sz2','o2',0,'lang','xx')`,
  `INSERT INTO posts (id, created_at, expires_at, status, title, body) VALUES
    ('p1',0,NULL,'published','Hello world','a public post'), ('X_p2',0,NULL,'draft','LEAK-draft','not yet'), ('X_p3',0,${EXPIRED},'published','LEAK-expired-post','gone')`,
  `INSERT INTO notes (id, owner, created_at, expires_at, title, body) VALUES
    ('n1','o1',0,NULL,'台北小籠包推薦','best xiaolongbao in town'), ('n2','o1',0,NULL,'Hello World','apple pie recipe'),
    ('n3','o1',0,NULL,'apple apple apple','apple'), ('n4','o1',0,NULL,'hello there','5% off, a_b literal'),
    ('n5','o1',0,NULL,'title:hello OR world','operators are literal'),
    ('X_n1','o2',0,NULL,'LEAK 小籠包 hello apple','LEAK'), ('X_n2','o1',0,${EXPIRED},'LEAK 小籠包 hello apple','LEAK')`,
  `INSERT INTO places (id, owner, created_at, expires_at, name, loc_lat, loc_lng) VALUES
    ('pl300','o1',0,NULL,'near300',${north(300)},${CENTER.lng}), ('pl1200','o1',0,NULL,'near1200',${north(1200)},${CENTER.lng}),
    ('pl4900','o1',0,NULL,'near4900',${north(4900)},${CENTER.lng}), ('pl5200','o1',0,NULL,'near5200',${north(5200)},${CENTER.lng}),
    ('pl10000','o1',0,NULL,'near10000',${north(10000)},${CENTER.lng}),
    ('X_pl1','o2',0,NULL,'LEAK-other-owner',${north(300)},${CENTER.lng}), ('X_pl2','o1',0,${EXPIRED},'LEAK-expired',${north(300)},${CENTER.lng})`,
];

export async function boot(extraSeed: string[] = [], only?: string[]): Promise<{ d1: LocalD1; schemas: Schemas }> {
  const d1 = await LocalD1.create();
  const s = only ? Object.fromEntries(Object.entries(schemas).filter(([k]) => only.includes(k))) : schemas;
  await d1.exec(storageDdl(s));
  await d1.exec([...seed.filter((q) => !only || only.some((t) => q.includes(`INTO ${t} `))), ...extraSeed]);
  return { d1, schemas: s };
}
export async function reset(d1: LocalD1) {
  for (const t of Object.keys(schemas)) await d1.exec([`DELETE FROM ${t}`]);
  await d1.exec(seed);
}

export const site = (b: { d1: LocalD1; schemas: Schemas }, hooks?: Hooks): Site => ({ ...b, hooks });

/** SQL text -> a Program, going through the CLI path (parse, validate with offsets, strip). */
export async function program(kind: 'view' | 'procedure', sql: string, inputs: Record<string, string> = {}, s: Schemas = schemas): Promise<Program> {
  return { kind, inputs, ir: (await lower(sql, { schemas: s, inputs, kind })).stmts };
}
