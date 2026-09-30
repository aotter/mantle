// @ts-nocheck test code over loosely typed IR and rows
/**
 * Shared fixtures and the harness the conformance cases run through: Schemas, two owners' rows (o1 is the
 * caller, o2 the other owner), rows that are expired or unpublished, and thin wrappers over the core runner.
 *
 * Every row the caller must never see has an id starting `X_` and text containing `LEAK`, so a probe can
 * assert "no result contains LEAK" without knowing what it queried.
 */
import { compileSql, DiagnosticError, RUNTIME_PLAN_VERSION, type RuntimePlan, type SqlDialect, type SqlNode } from "../spec/index.js";
import type { DatabaseDriver, SqlStatement } from "../core/driver.js";
import type { MantleDialect, StorageSchema, StoreCodec } from "../core/dialect.js";
import type { MantleStorageAdapter } from "../core/service.js";
import type { StoreExecutor } from "../core/store.js";
import { compileProgram as compileIr, type BindContext, type Compiled, type Mode } from "../core/sql/compile.js";
import type { RelationPosition } from "../core/sql/positions.js";
import { runProcedure as run, runView as runV, type LifecycleHooks, type Program } from "../core/sql/run.js";

export type { Program } from "../core/sql/run.js";

/** `stock >= 0` as IR, compiled the way the CLI compiles a Schema check (`compilePlan` will emit it). */
const ITEM_FIELDS = { name: "text", cat: "text", stock: "integer", tags: "json", note: "text" };
const check = async (text: string): Promise<SqlNode> => {
  const r = await compileSql(`SELECT 1 FROM items WHERE ${text}`, { schemas: { items: { scope: "owner", fields: ITEM_FIELDS } }, inputs: {}, kind: "view" });
  if (!r.ok) throw new Error(r.diagnostic.message);
  return r.plan.stmts[0]!.SelectStmt.whereClause;
};

/** The driver plus the few conveniences the cases use. */
export class Db {
  constructor(readonly driver: DatabaseDriver) {}
  async all(sql: string, binds: unknown[] = []): Promise<any[]> {
    return [...(await this.driver.batch([{ sql, binds }]))[0]!.rows];
  }
  batch(stmts: SqlStatement[]) {
    return this.driver.batch(stmts);
  }
  async exec(stmts: (string | SqlStatement)[]): Promise<void> {
    for (const s of stmts) await this.driver.batch([typeof s === "string" ? { sql: s } : s]);
  }
  /** Rows, or the error text (for probes that expect a refusal). */
  async try(sql: string, binds: unknown[] = []): Promise<{ rows: any[] } | { error: string }> {
    try {
      return { rows: await this.all(sql, binds) };
    } catch (e: any) {
      return { error: e.message };
    }
  }
}

export const NOW = Date.parse('2026-09-29T00:00:00Z') * 1000; // microseconds
export const caller = (input: Record<string, unknown> = {}, uid = 'o1'): BindContext => ({ uid, now: NOW, input });

export const schemas: Record<string, StorageSchema> = {
  items: { scope: 'owner', ttl: 'expires_at', ttlSeconds: 3600, fields: { name: 'text', cat: 'text', stock: 'integer', tags: 'json', note: 'text', expires_at: 'timestamptz' }, checks: [await check('stock >= 0')] },
  requisitions: { scope: 'owner', fields: { item_id: 'text', qty: 'integer', state: 'text' } },
  orders: { scope: 'owner', fields: { item_id: 'text', qty: 'integer', total: 'numeric(12,2)' } },
  settings: { scope: 'owner', fields: { key: 'text', value: 'text' }, unique: [['key']] },
  posts: { publishing: true, ttl: 'expires_at', ttlSeconds: 3600, fields: { title: 'text', body: 'text', expires_at: 'timestamptz' }, search: ['title', 'body'] },
  notes: { scope: 'owner', ttl: 'expires_at', ttlSeconds: 3600, fields: { title: 'text', body: 'text', expires_at: 'timestamptz' }, search: ['title', 'body'], unique: [['title']] },
  places: { scope: 'owner', ttl: 'expires_at', ttlSeconds: 3600, fields: { name: 'text', loc: 'geo', expires_at: 'timestamptz' } },
  events: { scope: 'owner', fields: { title: 'text', at: 'timestamptz', day: 'date', amount: 'numeric(12,2)', qty: 'integer' } },
};

/** a point and places at known distances north of it */
export const CENTER = { lat: 25.033, lng: 121.5654 };
const METERS_PER_DEGREE_LAT = (2 * Math.PI * 6_371_008.8) / 360;
export const north = (m: number) => CENTER.lat + m / METERS_PER_DEGREE_LAT;

/** An instant as the wire gives it; the fixture encodes it through the dialect's codec. */
export const iso = (us: number) => new Date(us / 1000).toISOString();
const FUTURE = iso(NOW + 1_000_000_000_000);
const T0 = iso(0);
const EXPIRED = T0;
/** Fixture SQL whose `${values}` become numbered binds. */
const q = (strings: TemplateStringsArray, ...binds: unknown[]): SqlStatement => ({ sql: strings.reduce((a, s, i) => `${a}?${i}${s}`), binds });
/** The fixture rows, typed values in the dialect's own storage encoding (the codec), so the seed is plain SQL on any engine. */
export const seed = ({ encode }: StoreCodec): SqlStatement[] => {
  const [t0, future, expired] = [T0, FUTURE, EXPIRED].map((v) => encode("timestamptz", v));
  const tags = (...t: string[]) => encode("json", t);
  const cents = (v: string) => encode("numeric(12,2)", v);
  return [
    q`INSERT INTO items (id, owner, created_at, expires_at, name, cat, stock, tags, note) VALUES
    ('a','o1',${t0},NULL,'apple','x',5,${tags("red", "big")},NULL), ('b','o1',${t0},NULL,'berry','x',2,${tags("blue")},NULL),
    ('c','o1',${t0},${future},'cherry','y',9,${tags("red")},'nc'), ('d','o1',${t0},NULL,'date','x',7,${tags("red")},'nd'),
    ('X_e1','o1',${t0},${expired},'LEAK-expired','x',100,${tags("LEAK-tag")},NULL),
    ('X_z1','o2',${t0},NULL,'LEAK-zeta','x',50,${tags("LEAK-tag")},NULL), ('X_z2','o2',${t0},NULL,'LEAK-zulu','y',60,${tags("LEAK-tag")},NULL)`,
    q`INSERT INTO requisitions (id, owner, created_at, item_id, qty, state) VALUES ('r1','o1',${t0},'a',2,'pending'), ('r2','o1',${t0},'b',1,'pending'), ('X_rz','o2',${t0},'X_z1',1,'pending')`,
    q`INSERT INTO orders (id, owner, created_at, item_id, qty, total) VALUES
    ('oa','o1',${t0},'a',3,${cents("10.50")}), ('ob','o1',${t0},'a',1,${cents("3.50")}), ('oe','o1',${t0},'X_e1',9,${cents("9.00")}), ('X_oz','o2',${t0},'a',99,${cents("99.00")}), ('X_oz2','o2',${t0},'X_z1',5,${cents("5.00")})`,
    q`INSERT INTO settings (id, owner, created_at, key, value) VALUES ('s1','o1',${t0},'theme','dark'), ('X_sz','o2',${t0},'theme','dark'), ('X_sz2','o2',${t0},'lang','xx')`,
    q`INSERT INTO posts (id, created_at, expires_at, status, title, body) VALUES
    ('p1',${t0},NULL,'published','Hello world','a public post'), ('X_p2',${t0},NULL,'draft','LEAK-draft','not yet'), ('X_p3',${t0},${expired},'published','LEAK-expired-post','gone')`,
    q`INSERT INTO notes (id, owner, created_at, expires_at, title, body) VALUES
    ('n1','o1',${t0},NULL,'台北小籠包推薦','best xiaolongbao in town'), ('n2','o1',${t0},NULL,'Hello World','apple pie recipe'),
    ('n3','o1',${t0},NULL,'apple apple apple','apple'), ('n4','o1',${t0},NULL,'hello there','5% off, a_b literal'),
    ('n5','o1',${t0},NULL,'title:hello OR world','operators are literal'),
    ('X_n1','o2',${t0},NULL,'LEAK 小籠包 hello apple','LEAK'), ('X_n2','o1',${t0},${expired},'LEAK 小籠包 hello apple','LEAK')`,
    q`INSERT INTO places (id, owner, created_at, expires_at, name, loc_lat, loc_lng) VALUES
    ('pl300','o1',${t0},NULL,'near300',${north(300)},${CENTER.lng}), ('pl1200','o1',${t0},NULL,'near1200',${north(1200)},${CENTER.lng}),
    ('pl4900','o1',${t0},NULL,'near4900',${north(4900)},${CENTER.lng}), ('pl5200','o1',${t0},NULL,'near5200',${north(5200)},${CENTER.lng}),
    ('pl10000','o1',${t0},NULL,'near10000',${north(10000)},${CENTER.lng}),
    ('X_pl1','o2',${t0},NULL,'LEAK-other-owner',${north(300)},${CENTER.lng}), ('X_pl2','o1',${t0},${expired},'LEAK-expired',${north(300)},${CENTER.lng})`,
  ];
};


/** What the engine under test is: its storage adapter (the dialect's runtime side) and a driver for fixture SQL. */
export interface Engine {
  readonly storage: MantleStorageAdapter;
  readonly driver: DatabaseDriver;
}
export type Booted = { d1: Db; schemas: Record<string, StorageSchema>; executor: StoreExecutor; dialect: MantleDialect };

/** Converge the fixture Schemas through the dialect, then seed them with plain SQL. */
export async function boot(engine: Engine): Promise<Booted> {
  const d1 = new Db(engine.driver);
  const { name, version } = engine.storage.dialect;
  // a whole plan, so a dialect that reads more of it than the Schemas sees one; the fixture declares no Views or Procedures
  const plan: RuntimePlan = { version: RUNTIME_PLAN_VERSION, dialect: { name, version }, fingerprint: "conformance", views: {}, procedures: {}, triggers: {},
    schemas: Object.fromEntries(Object.entries(schemas).map(([n, d]) => [n, { ...d, name: n, names: {}, schema: { type: "object" } }])) };
  const { executor } = await engine.storage.prepare(plan);
  await d1.exec(seed(engine.storage.dialect.codec));
  return { d1, schemas, executor, dialect: engine.storage.dialect };
}

/** The compile side the cases compile with; the suite sets it from its options (D1 when unset). */
let compileSide: SqlDialect | undefined;
export const useCompileSide = (dialect: SqlDialect | undefined) => { compileSide = dialect; };
export async function reset(b: Booted) {
  for (const t of Object.keys(schemas)) await b.d1.exec([`DELETE FROM ${t}`]);
  await b.d1.exec(seed(b.dialect.codec));
}

// ---- hooks: the cases write plain callbacks; the runner sees a LifecycleDispatcher -----------------------------------------
export type Verb = "insert" | "update" | "delete";
export type Hooks = {
  before?: Record<string, Partial<Record<Verb, (cause: { row: any }) => unknown>>>;
  after?: Record<string, Partial<Record<Verb, (cause: { rows: [any, ...any[]] }) => unknown>>>;
};
const VERB: Record<string, Verb> = { create: "insert", update: "update", delete: "delete" };
const keys = (h: Hooks["before"]) => new Set(Object.entries(h ?? {}).flatMap(([s, v]) => Object.keys(v).map((verb) => `${s}.${verb}`)));
function lifecycleOf(h: Hooks | undefined): LifecycleHooks | undefined {
  if (!h) return undefined;
  const call = async (stage: "before" | "after", events: readonly any[]) => {
    for (const e of events) {
      const verb = VERB[e.hook.split("_")[1]]!;
      await (h[stage] as any)?.[e.schema]?.[verb]?.(stage === "before" ? { row: e.rows[0] } : { rows: e.rows });
    }
  };
  return { dispatcher: { before: (e) => call("before", e), after: (e) => call("after", e) }, before: keys(h.before), after: keys(h.after) };
}

export type Site = Booted & {
  hooks?: Hooks;
  mode?: Mode;
  seen?: Set<RelationPosition>;
  unsafeNoVisibility?: boolean;
};
export const site = (b: Booted, hooks?: Hooks): Site => ({ ...b, hooks });

/** SQL text to a Program, going through the CLI path (parse, validate with offsets, strip). */
export async function program(kind: "view" | "procedure", sql: string, inputs: Record<string, string> = {}, s = schemas): Promise<Program> {
  const r = await compileSql(sql, { schemas: s, inputs, kind }, compileSide);
  if (!r.ok) throw new Error(`${r.diagnostic.code}: ${r.diagnostic.message}`);
  return { kind, inputs, ir: r.plan.stmts };
}

/** The dialect's executor, recording each applied statement (IR and binds). */
const recording = (inner: StoreExecutor) => {
  const batches: { ir: SqlNode; binds: readonly unknown[] }[] = [];
  const executor: StoreExecutor = { maxBindings: inner.maxBindings, select: (s) => inner.select(s), apply: (b) => (batches.push(...b.map((s) => ({ ir: s.ir, binds: s.binds }))), inner.apply(b)) };
  return Object.assign(executor, { batches });
};
const envOf = (s: Site, executor = recording(s.executor)) => ({
  executor, dialect: s.dialect, schemas: s.schemas, mode: s.mode, seen: s.seen, unsafeNoVisibility: s.unsafeNoVisibility, lifecycle: lifecycleOf(s.hooks),
});
const asOf = (bind: BindContext) => ({
  bind,
  caller: { kind: "user", subject: bind.uid, role: null, scopes: [], credential: "session", credentialId: null, clientId: null } as const,
  cause: { kind: "internal", id: "conformance" } as const,
});

export async function runProcedure(s: Site, p: Program, bind: BindContext) {
  const env = envOf(s);
  const { rows } = await run(env, p, asOf(bind));
  return { rows: rows as any[][], batch: env.executor.batches };
}
export async function runView(s: Site, p: Program, bind: BindContext, opts: { cursor?: unknown[]; pageSize?: number } = {}) {
  return runV(envOf(s), p, asOf(bind), opts);
}
export const compileProgram = (s: Site, p: Program): Compiled[] =>
  compileIr(p.ir, { dialect: s.dialect, schemas: s.schemas, inputs: p.inputs, kind: p.kind, mode: s.mode, seen: s.seen, unsafeNoVisibility: s.unsafeNoVisibility });

// ---- what the cases assert on ------------------------------------------------------------------------------------------------
const diag = (e: unknown) => (e instanceof DiagnosticError ? e.diagnostic : undefined);
export const isConflict = (e: unknown) => diag(e)?.code === "CONFLICT";
export const opIndexOf = (e: unknown) => diag(e)?.conflict?.opIndex;
export const isCheck = (e: unknown) => diag(e)?.code === "INPUT_VALIDATION_FAILED" && /^CHECK /.test(diag(e)!.message);
/** A refusal of the IR or of the write: `INPUT_VALIDATION_FAILED` whose message starts with the SQL_* code. */
export const isRefusal = (e: unknown, code?: string) => diag(e)?.code === "INPUT_VALIDATION_FAILED" && (!code || diag(e)!.message.startsWith(`${code}:`) || new RegExp(`\\b${code}\\b`).test(diag(e)!.message));
