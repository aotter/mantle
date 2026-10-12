/**
 * The Store on one real driver: scope, trusted mode, TTL, keyset paging, every operator, refusals and inert hostile input, OCC,
 * unique CONFLICT, placeholder continuation and wire forms (rows are keyed by storage column names), each checked against an independent model of the seeded rows and native SQL. Runs under
 * bun:test (bun:sqlite, a D1 shim, Bun.SQL) and in verify-native (the four real hosts), so it uses node:assert only.
 */
import assert from "node:assert/strict";
import type { Caller } from "../src/kernel/contracts.js";
import { user } from "./apps/fixtures.js";

const system: Caller = { kind: "system", reason: "store-scenario" };
const anonymous: Caller = { kind: "anonymous" };
const A = "store-owner-a", B = "store-owner-b";

export interface StoreEnv {
  sqlite: boolean;
  store(caller: Caller): any;
  beginOptions: string[];
  /** The generated `stores` bound to the target's database handle for this caller. */
  stores(caller: Caller): { purchase_requests: any; session_notes: any; catalog_items: any };
  /** A generated View on the same handle. */
  view(name: string, caller: Caller, input: Record<string, unknown>): Promise<Record<string, unknown>[]>;
  /** A generated Procedure on the same handle. */
  call(name: string, caller: Caller, input: Record<string, unknown>): Promise<any>;
  /** Independent native SQL with `?` placeholders. */
  native(sql: string, values?: readonly unknown[]): Promise<Record<string, unknown>[]>;
  /** What the driver was asked to run for one Store call (bun:test only). */
  record?(caller: Caller, run: (stores: ReturnType<StoreEnv["stores"]>) => Promise<unknown>): Promise<{ sql: string; values: unknown[] }>;
}

/** The scenarios' view of a generated app (`import * as app`) on one handle. `spy(calls)` builds a handle that logs what it runs (it enables the placeholder checks). */
export const storeEnv = (app: { store: any; views: any; procedures: any }, handle: unknown, sqlite: boolean, native: StoreEnv["native"], spy?: (calls: { sql: string; values: unknown[] }[]) => unknown): StoreEnv => {
  const beginOptions: string[] = [];
  const db: any = handle;
  const tracked = sqlite ? handle : { unsafe: db.unsafe.bind(db), begin: (options: string, fn: any) => { beginOptions.push(options); return db.begin(options, fn); } };
  const store = (caller: Caller) => app.store(tracked, caller);
  const stores = (caller: Caller, db = tracked) => { const store = app.store(db, caller); return { purchase_requests: store.collection("purchase_requests"), session_notes: store.collection("session_notes"), catalog_items: store.collection("catalog_items") }; };
  return {
    sqlite, native, stores, store, beginOptions,
    view: (name, caller, input) => app.views[name](tracked, caller, input),
    call: (name, caller, input) => app.procedures[name](tracked, caller, input),
    ...(spy && { record: async (caller, run) => { const calls: { sql: string; values: unknown[] }[] = []; await run(stores(caller, spy(calls))); return calls.at(-1)!; } }),
  };
};

type Model = { requestNumber: string; title: string; amount: number; approved: boolean; requestedUnits: number; submittedAt: string; neededOn: string; sortBucket: string | null; id: string };
const model = (owner: string, i: number): Omit<Model, "id"> => ({
  requestNumber: `S-${owner}-${String(i).padStart(3, "0")}`, title: `Item ${i % 12}`, amount: (i % 7) * 2.5, approved: i % 3 === 0, requestedUnits: (i % 5) + 1,
  submittedAt: `2026-10-11T00:0${i % 9}:00.123456Z`, neededOn: `2026-10-1${2 + (i % 6)}`, sortBucket: i % 4 === 0 ? null : `bucket-${i % 3}`,
});
const ROWS = 60;
const num = (v: unknown) => Number(v);
const refused = (p: PromiseLike<unknown>, code = "INPUT_VALIDATION_FAILED") => assert.rejects(Promise.resolve(p), (e: any) => e?.code === code, `expected ${code}`);
/** Only the generated types stop these; at run time they must be inert: a database error or no rows, never a changed row. */
const inert = async (p: Promise<any>) => { const r = await p.then(v => v, () => undefined); assert.ok(r == null || r === 0 || r.rows?.length === 0, `not inert: ${JSON.stringify(r)}`); };
/** A read the types forbid: a database error, or rows that are still only the caller's own (wrong at worst, never another scope's). */
const scoped = (theirs: Set<string>) => async (p: Promise<any>) => { const r = await p.then(v => v, () => undefined); assert.ok(r === undefined || r === null || r.rows?.every((x: any) => !theirs.has(x.id)), "left the scope"); };
const COLUMNS = ["amount", "approved", "author_id", "created_at", "id", "neededon", "payload", "requestedunits", "requestnumber", "sortbucket", "submittedat", "title", "updated_at", "version"];

export async function verifyStore(env: StoreEnv) {
  let checks = 0;
  const ok = () => { checks++; };
  // ---- seed: two owners through the generated Procedure, a TTL Schema and an unscoped one
  const create = (owner: string, m: Omit<Model, "id">) => env.call("create-purchase", user(owner), { ...m, approved: env.sqlite ? Number(m.approved) : m.approved, payload: JSON.stringify({ n: m.requestNumber }) });
  for (const owner of [A, B]) for (let i = 0; i < ROWS; i++) await create(owner, model(owner, i));
  const ids = new Map((await env.native("SELECT id, requestnumber FROM purchase_requests WHERE requestnumber LIKE ?", ["S-store-owner-%"])).map(r => [String(r.requestnumber), String(r.id)]));
  const mine = (owner: string): Model[] => Array.from({ length: ROWS }, (_, i) => { const m = model(owner, i); return { ...m, id: ids.get(m.requestNumber)! }; });
  const a = env.stores(user(A)).purchase_requests, b = env.stores(user(B)).purchase_requests, sys = env.stores(system).purchase_requests;
  const rowsA = mine(A), rowsB = mine(B);
  const drain = async (store: any, q: Record<string, unknown>, limit: number) => {
    const out: any[] = []; let cursor: string | null = null, pages = 0;
    do { const page: { rows: any[]; cursor: string | null } = await store.find({ ...q, limit, ...(cursor ? { cursor } : {}) }); out.push(...page.rows); cursor = page.cursor; assert.ok(++pages < 1000, `paging never ends: ${JSON.stringify(q)} by ${limit}`); } while (cursor);
    return out;
  };

  // ---- scope: another owner's rows do not exist for a caller
  assert.equal(await a.count({ requestnumber: { like: "S-%" } }), ROWS); ok();
  assert.equal((await a.find({ limit: 500 })).rows.every((r: any) => String(r.requestnumber).startsWith(`S-${A}-`) || String(r.requestnumber).startsWith("REQ-")), true); ok();
  const bRow = rowsB[3]!, elsewhere = scoped(new Set(rowsB.map(r => r.id)));
  assert.equal(await a.findById(bRow.id), null); ok();
  assert.equal(await a.first({ where: { id: bRow.id } }), null); ok();
  assert.equal((await a.find({ where: { id: { in: [bRow.id, rowsA[0]!.id] } } })).rows.length, 1); ok();
  assert.equal((await a.find({ where: { ownerid: B } as never })).rows.length, 0); // the scope column can be named, but the caller's own scope still applies
  await refused(a.update(bRow.id, { title: "taken" }, { lock: 1 }), "CONFLICT"); ok();
  assert.equal((await b.findById(bRow.id)).title, bRow.title); ok();
  // anonymous: Core's scope predicate matches nothing; an unscoped Schema stays readable
  const anon = env.stores(anonymous);
  assert.deepEqual([...(await anon.purchase_requests.find()).rows], []); assert.equal(await anon.purchase_requests.count(), 0); ok();
  await refused(anon.session_notes.insert({ body: "anonymous", expiresat: null }), "UNAUTHENTICATED");
  assert.deepEqual(await env.native("SELECT id FROM session_notes WHERE body = ?", ["anonymous"]), []); ok();

  // ---- trusted mode: no scope predicate, both owners
  assert.equal(await sys.count({ requestnumber: { like: "S-%" } }), ROWS * 2); ok();
  assert.equal(await sys.count({ ownerid: B, requestnumber: { like: "S-%" } } as never), ROWS); ok();
  assert.equal((await sys.findById(bRow.id)).title, bRow.title); ok();

  // ---- keyset paging: every NOT NULL indexed column (the only ones the generated type offers), both directions, ties, any page size
  const sorted = (rows: Model[], key: string, dir: "asc" | "desc") => [...rows].sort((x, y) => {
    const kx = (x as any)[key], ky = (y as any)[key];
    const c = kx === ky ? (x.id < y.id ? -1 : 1) : kx < ky ? -1 : 1;
    return dir === "asc" ? c : -c;
  }).map(r => r.id);
  for (const [key, field] of [["id", "id"], ["amount", "amount"], ["approved", "approved"], ["requestedunits", "requestedUnits"], ["submittedat", "submittedAt"], ["neededon", "neededOn"], ["title", "title"], ["requestnumber", "requestNumber"]] as const) {
    const expected = (dir: "asc" | "desc") => sorted(rowsA.map(r => ({ ...r, approved: r.approved ? 1 : 0 }) as never), field, dir);
    for (const dir of ["asc", "desc"] as const) for (const limit of [1, 7, 25, 60, 500]) {
      const got = (await drain(a, { where: { requestnumber: { like: "S-%" } }, orderBy: key, order: dir }, limit)).map(r => r.id);
      assert.deepEqual(got, expected(dir), `${key} ${dir} pages of ${limit}`);
    }
  }
  ok();
  // a filter stays in force on every page, and the last page has no cursor
  const filtered = await drain(a, { where: { approved: true, sortbucket: null }, orderBy: "title" }, 3);
  assert.equal(filtered.length, rowsA.filter(r => r.approved && r.sortBucket === null).length); assert.ok(filtered.every((r: any) => r.sortbucket === null && (r.approved === 1 || r.approved === true))); ok();
  const last = await a.find({ limit: ROWS }); assert.equal(last.cursor === null || last.rows.length === ROWS, true); ok();
  // a forged or malformed cursor is only ever bound values: it cannot leave the scope, and a bad one is an error or an empty page
  for (const cursor of ["%%%", btoa("[1,2]"), "null", "[]", "[1,2,3]", encodeURIComponent("{}")]) await refused(a.find({ cursor, limit: 500 })); // not a cursor
  for (const cursor of [encodeURIComponent(JSON.stringify([{ a: 1 }, ["x"]])), encodeURIComponent(JSON.stringify([`' OR 1=1 --`, `' OR 1=1 --`]))]) await elsewhere(a.find({ cursor, limit: 500 }));
  for (const forged of [[bRow.id, bRow.id], ["", ""], [null, bRow.id]]) {
    for (const orderBy of ["id", "title"] as const) assert.ok((await a.find({ orderBy, cursor: encodeURIComponent(JSON.stringify(forged)), limit: 500 })).rows.every((r: any) => !rowsB.some(x => x.id === r.id)));
  }
  ok();

  // ---- operators
  const n = (where: Record<string, unknown>) => a.count({ requestnumber: { like: "S-%" }, ...where });
  const m = (f: (x: Model) => boolean) => rowsA.filter(f).length;
  assert.equal(await n({ sortbucket: null }), m(x => x.sortBucket === null));
  assert.equal(await n({ sortbucket: { isNull: true } }), m(x => x.sortBucket === null));
  assert.equal(await n({ sortbucket: { isNull: false } }), m(x => x.sortBucket !== null));
  assert.equal(await n({ sortbucket: { eq: null } }), m(x => x.sortBucket === null));
  assert.equal(await n({ sortbucket: { ne: null } }), m(x => x.sortBucket !== null));
  assert.equal(await n({ sortbucket: { ne: "bucket-1" } }), m(x => x.sortBucket !== null && x.sortBucket !== "bucket-1")); // SQL <>: NULL rows do not match
  assert.equal(await n({ sortbucket: { in: ["bucket-1", "bucket-2"] } }), m(x => x.sortBucket === "bucket-1" || x.sortBucket === "bucket-2"));
  assert.equal(await n({ sortbucket: { notIn: ["bucket-1"] } }), m(x => x.sortBucket !== null && x.sortBucket !== "bucket-1"));
  assert.equal(await n({ sortbucket: { in: [] } }), 0); assert.equal(await n({ sortbucket: { notIn: [] } }), ROWS);
  assert.equal(await n({ title: { like: "Item 1%" } }), m(x => x.title.startsWith("Item 1")));
  assert.equal(await n({ title: { like: "Item _" } }), m(x => /^Item \d$/.test(x.title)));
  assert.equal(await n({ amount: { gte: 5, lt: 12.5 } }), m(x => x.amount >= 5 && x.amount < 12.5));
  assert.equal(await n({ amount: { gt: 5, lte: 12.5 } }), m(x => x.amount > 5 && x.amount <= 12.5));
  assert.equal(await n({ amount: { eq: 2.5 } }), m(x => x.amount === 2.5)); assert.equal(await n({ amount: { ne: 2.5 } }), m(x => x.amount !== 2.5));
  assert.equal(await n({ approved: true }), m(x => x.approved)); assert.equal(await n({ approved: { ne: true } }), m(x => !x.approved));
  assert.equal(await n({ requestedunits: { in: [1, 2, 99] } }), m(x => x.requestedUnits <= 2));
  assert.equal(await n({ submittedat: { gte: "2026-10-11T00:04:00.123456Z" } }), m(x => x.submittedAt >= "2026-10-11T00:04:00.123456Z"));
  assert.equal(await n({ submittedat: new Date("2026-10-11T00:03:00.123Z") }), 0); // Date works; microseconds differ
  assert.equal(await n({ submittedat: { lt: new Date("2026-10-11T00:03:00.200Z") } }), m(x => x.submittedAt < "2026-10-11T00:03:00.200000Z"));
  assert.equal(await n({ neededon: "2026-10-13" }), m(x => x.neededOn === "2026-10-13")); assert.equal(await n({ neededon: { in: ["2026-10-12", "2026-10-15"] } }), m(x => x.neededOn === "2026-10-12" || x.neededOn === "2026-10-15"));
  assert.equal(await n({ title: "Item 3", amount: 2.5, approved: false }), m(x => x.title === "Item 3" && x.amount === 2.5 && !x.approved));
  assert.equal(await a.count({ created_at: { gte: "2020-01-01T00:00:00Z" }, requestnumber: { like: "S-%" } }), ROWS); ok();

  // ---- refusals and inert input: operators, shapes, limits and system columns are refused; a column name is only ever a quoted identifier
  const hostile = "'; DROP TABLE purchase_requests; --";
  const total = async () => num((await env.native("SELECT COUNT(*) AS c FROM purchase_requests WHERE requestnumber LIKE ?", ["S-%"]))[0]!.c);
  // what only the generated types stop: no row outside the caller's scope, no SQL from a value, no changed row
  await elsewhere(a.find({ where: { title: { "= 1 OR 1=1 --": 1 } } as never })); await elsewhere(a.find({ where: { title: undefined } as never }));
  await elsewhere(a.find({ where: { title: { a: 1 } } as never })); await elsewhere(a.find({ where: { title: { __proto__: 1, constructor: 2 } } as never }));
  assert.equal((await a.find({ order: "sideways" as never, limit: 500 })).rows.every((r: any) => !rowsB.some(x => x.id === r.id)), true);
  await refused(a.find({ limit: 0 })); await refused(a.find({ limit: 501 })); await refused(a.find({ limit: 1.5 }));
  await elsewhere(a.find({ order: "asc; DROP TABLE x" as never, limit: 500 }));
  await inert(a.findById({} as never)); await inert(a.findById(undefined as never));
  // an unknown column (hostile text, a dotted name, another table's column) is a database error: it never becomes SQL
  for (const name of [hostile, "title\" = 1 OR \"1", "r.title", "purchase_requests.title", "nosuchcolumn"]) {
    await assert.rejects(a.find({ where: { [name]: 1 } as never })); await assert.rejects(a.find({ orderBy: name as never })); await assert.rejects(a.count({ [name]: { like: "x" } } as never));
  }
  await inert(a.find({ where: { amount: { gt: null } } as never })); await inert(a.find({ where: { payload: "x" } as never })); await inert(a.find({ where: { title: { in: "x" } } as never }));
  assert.equal((await a.find({ where: { title: hostile } })).rows.length, 0);
  // system columns and the scope column are never written, however they are spelled (SQLite matches names without case)
  const wr = (await a.first({ where: { requestnumber: rowsA[2]!.requestNumber } }))!;
  for (const name of ["ownerid", "OwnerId", "OWNERID", "id", "Id", "version", "VERSION", "created_at", "Created_At", "updated_at", "author_id", "_rid", "status"]) {
    await refused(a.update(wr.id, { [name]: B } as never, { lock: wr.version })); await refused(a.insert({ [name]: B } as never));
  }
  assert.equal(await total(), ROWS * 2);
  for (const lock of ["1; DROP", "abc", 1.5, NaN, null, undefined]) await assert.rejects(Promise.resolve(a.update(wr.id, { title: "t" }, { lock: lock as never })));
  await refused(a.update("x", {}, { lock: 1 }), "CONFLICT"); await refused(a.update(wr.id, { title: "t" }, { lock: wr.version + 1 }), "CONFLICT");
  // undefined would be bound as NULL and clear a nullable column: refused. As a filter it matches nothing.
  await refused(a.update(wr.id, { title: undefined } as never, { lock: wr.version })); await refused(a.update(wr.id, { sortbucket: undefined } as never, { lock: wr.version })); await refused(a.insert({ sortbucket: undefined } as never));
  // a dotted write column is a database error and moves nothing
  for (const name of ["purchase_requests.ownerid", "r.ownerid", "title\" = 'x', \"ownerid"]) { await assert.rejects(async () => a.update(wr.id, { [name]: B } as never, { lock: wr.version })); await assert.rejects(async () => a.insert({ [name]: B } as never)); }
  const nativeWritten = (await env.native("SELECT ownerid, title, version FROM purchase_requests WHERE id = ?", [wr.id]))[0]!;
  assert.deepEqual({ ...nativeWritten, version: Number(nativeWritten.version) }, { ownerid: A, title: wr.title, version: wr.version });
  assert.equal(await total(), ROWS * 2); ok();

  // ---- wire forms: ISO UTC with six digits and plain dates from SQL itself; booleans and JSON are the driver's own
  const r = (await a.first({ where: { requestnumber: rowsA[1]!.requestNumber } }))!;
  assert.equal(r.submittedat, rowsA[1]!.submittedAt); assert.equal(r.neededon, rowsA[1]!.neededOn); assert.match(r.created_at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/);
  assert.equal(r.approved, env.sqlite ? 0 : false); assert.deepEqual(env.sqlite ? JSON.parse(r.payload) : r.payload, { n: r.requestnumber });
  assert.deepEqual(await a.findById(r.id), r); ok();
  const direct = (await env.native("SELECT requestnumber FROM purchase_requests WHERE id = ?", [r.id]))[0]!; assert.equal(direct.requestnumber, r.requestnumber); ok();

  // ---- update: scope + explicit OCC, one statement, the new row back
  const u = await a.update(r.id, { title: "renamed", amount: 99.5, approved: true, submittedat: "2027-01-02T03:04:05.654321Z", neededon: "2027-02-03", payload: { a: 1 }, sortbucket: null }, { lock: r.version });
  assert.equal(u.title, "renamed"); assert.equal(num(u.amount), 99.5); assert.equal(num(u.version), num(r.version) + 1); assert.equal(u.submittedat, "2027-01-02T03:04:05.654321Z"); assert.equal(u.neededon, "2027-02-03");
  assert.equal(u.sortbucket, null); assert.equal(u.approved, env.sqlite ? 1 : true); assert.deepEqual(env.sqlite ? JSON.parse(u.payload) : u.payload, { a: 1 }); assert.equal(u.requestnumber, r.requestnumber); ok();
  assert.deepEqual(await a.findById(r.id), u); ok();
  await refused(a.update(r.id, { title: "stale" }, { lock: r.version }), "CONFLICT"); assert.equal((await a.findById(r.id)).title, "renamed"); ok();
  await refused(a.update("no-such-id", { title: "t" }, { lock: 1 }), "CONFLICT"); ok();
  const keep = await a.update(r.id, { title: "only title" }, { lock: u.version }); assert.equal(keep.amount, u.amount); assert.equal(keep.submittedat, u.submittedat); assert.deepEqual(env.sqlite ? JSON.parse(keep.payload) : keep.payload, { a: 1 }); ok();
  await a.update(r.id, { sortbucket: "back" }, { lock: keep.version }); ok();
  // the trusted write has no scope predicate; the foreign row moves from its own version
  const owned = (await b.findById(bRow.id)), moved = await sys.update(bRow.id, { title: "system edit" }, { lock: owned.version });
  assert.equal(moved.title, "system edit"); assert.equal((await b.findById(bRow.id)).title, "system edit"); ok();
  assert.equal(num((await env.native("SELECT COUNT(*) AS c FROM purchase_requests WHERE title = ?", ["system edit"]))[0]!.c), 1); ok();

  // ---- TTL (the cutoff binds after the uid) and an unscoped Schema
  const hour = 3_600_000, at = (ms: number) => new Date(Date.now() + ms).toISOString();
  for (const [body, expiresAt] of [["live", at(hour)], ["forever", null], ["gone", at(-hour)]] as const) await env.call("create-session-note", user(A), { body, expiresAt });
  const notes = env.stores(user(A)).session_notes;
  assert.deepEqual((await notes.find({ orderBy: "body" })).rows.map((x: any) => x.body), ["forever", "live"]); ok();
  assert.deepEqual((await env.stores(system).session_notes.find({ orderBy: "body", where: { body: { in: ["live", "forever", "gone"] } } })).rows.map((x: any) => x.body), ["forever", "live"]); ok();
  assert.equal((await env.stores(user(B)).session_notes.find()).rows.length, 0);
  const live = (await notes.first({ where: { body: "live" } }))!;
  assert.ok((await notes.update(live.id, { expiresat: null }, { lock: live.version })).expiresat === null); ok();
  assert.equal((await env.native("SELECT id FROM session_notes WHERE body = ?", ["gone"])).length, 1);
  for (const [sku, name, price] of [["c-1", "pen", 1.5], ["c-2", "ink", 4], ["c-3", "pad", 2]] as const) await env.call("create-catalog-item", user(A), { sku, name, price });
  const catalog = (caller: Caller) => env.stores(caller).catalog_items;
  for (const caller of [user(A), user(B), anonymous, system]) assert.deepEqual((await catalog(caller).find({ orderBy: "name" })).rows.map((x: any) => x.name), ["ink", "pad", "pen"]);
  ok();

  // ---- insert and delete: Core's fills (scope, author, clock, generated id), refusals, OCC and scope on delete, unique CONFLICT
  const row = (n: string, extra: object = {}) => ({ requestnumber: n, title: "inserted", amount: 1.5, approved: false, requestedunits: 2, submittedat: "2026-10-11T00:00:00.5Z", neededon: "2026-10-11", payload: { k: 1 }, sortbucket: null, ...extra });
  const made = await a.insert(row("I-1"));
  assert.match(made.id, /^[0-9a-f]{32}$/); assert.match(rowsA[0]!.id, /^[0-9a-f]{32}$/, "Core's compiled INSERT ids have the same shape"); assert.equal(num(made.version), 1); assert.equal(made.author_id, A); assert.equal(made.submittedat, "2026-10-11T00:00:00.500000Z");
  assert.match(made.created_at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/); assert.equal(made.created_at, made.updated_at);
  assert.deepEqual(Object.keys(made).sort(), COLUMNS); assert.deepEqual(Object.keys((await a.findById(made.id))).sort(), COLUMNS); assert.deepEqual(Object.keys((await sys.findById(made.id))).sort(), COLUMNS);
  assert.equal(await b.findById(made.id), null); assert.equal((await sys.findById(made.id)).title, "inserted"); assert.equal((await env.native("SELECT ownerid FROM purchase_requests WHERE id = ?", [made.id]))[0]!.ownerid, A); ok();
  // a unique-index clash is CONFLICT on insert and on update, as in a generated Procedure
  await refused(a.insert(row("I-1", { title: "again" })), "CONFLICT");
  const other = await a.insert(row("I-2")); await refused(a.update(other.id, { requestnumber: "I-1" }, { lock: other.version }), "CONFLICT");
  assert.equal((await a.findById(other.id)).requestnumber, "I-2"); await a.delete(other.id, { lock: other.version });
  assert.equal((await b.insert(row("I-1", { title: "b's" }))).title, "b's"); // unique per owner
  // a required, non-null field is NOT NULL in the database, so the orderBy promise holds for any writer: natively, through the Store and through a Procedure
  const nulls = async (n: string) => num((await env.native("SELECT COUNT(*) AS c FROM catalog_items WHERE sku = ? OR name = ? OR price IS NULL", [n, n]))[0]!.c);
  for (const column of ["sku", "name", "price"]) {
    const given: Record<string, unknown> = { sku: "n-1", name: "n-1", price: 1, [column]: null };
    await assert.rejects(env.native(`INSERT INTO catalog_items (id, created_at, sku, name, price) VALUES (?, ?, ?, ?, ?)`, ["null-test", env.sqlite ? 0 : "2026-01-01T00:00:00Z", given.sku, given.name, given.price]), /null/i, `native ${column}`);
    await assert.rejects(async () => catalog(user(A)).insert(given as never), /null/i, `Store ${column}`);
    await assert.rejects(env.call("create-catalog-item", user(A), given), /null/i, `Procedure ${column}`);
  }
  assert.equal(await nulls("n-1"), 0); ok();
  // a keyset cursor carries any text (it is percent-encoded JSON)
  const uni = [await a.insert(row("U-1", { title: "測試 é" })), await a.insert(row("U-2", { title: "測試 ü" }))];
  const upage = await a.find({ where: { requestnumber: { like: "U-%" } }, orderBy: "title", limit: 1 });
  assert.equal(upage.rows[0].id, uni[0]!.id); assert.equal((await a.find({ where: { requestnumber: { like: "U-%" } }, orderBy: "title", limit: 1, cursor: upage.cursor! })).rows[0].id, uni[1]!.id);
  for (const u of uni) await a.delete(u.id, { lock: u.version });
  await assert.rejects(async () => anon.purchase_requests.insert(row("anon"))); // no subject: the scope column is NOT NULL
  const note = await notes.insert({ body: "inserted note", expiresat: new Date(Date.now() + hour) }); assert.equal(note.body, "inserted note");
  assert.equal((await notes.findById(note.id)).id, note.id); assert.equal((await env.stores(user(B)).session_notes.findById(note.id)), null);
  const item = await catalog(user(B)).insert({ sku: "c-9", name: "tape", price: 3 }); assert.equal(item.author_id, B); assert.equal((await catalog(user(A)).findById(item.id)).sku, "c-9"); ok();
  await refused(b.delete(made.id, { lock: 1 }), "CONFLICT"); await refused(a.delete(made.id, { lock: 2 }), "CONFLICT"); await refused(a.delete("no-such-id", { lock: 1 }), "CONFLICT");
  await assert.rejects(async () => a.delete(made.id, { lock: "x" as never })); await assert.rejects(async () => a.delete({} as never, { lock: 1 }));
  assert.equal(await a.delete(made.id, { lock: made.version }), undefined); assert.equal(await a.findById(made.id), null); assert.equal(await sys.findById(made.id), null); ok();
  await catalog(system).delete(item.id, { lock: item.version }); assert.equal(await catalog(system).findById(item.id), null); ok();

  // ---- equivalence: for every Schema and mode, the generic Store's rows are the rows Core's compiled SQL returns
  const stores = env.stores;
  const same = async (name: string, caller: Caller, store: any, where: object, rows: boolean) => {
    const got = (await store.find({ where, limit: 500 })).rows;
    // `*` also returns a geo field's two columns, which no View can name
    for (const r of got) { assert.ok(name.startsWith("eq-catalog") ? r.place_lat === null && r.place_lng === null : !("place_lat" in r)); delete r.place_lat; delete r.place_lng; }
    assert.deepEqual(got, await env.view(name, caller, {}), `${name} as ${caller.kind}`);
    assert.equal(got.length > 0, rows, `${name} as ${caller.kind}: ${rows ? "vacuous" : "leaks rows"}`);
  };
  const purchases = { amount: { gte: 2.5 }, title: { like: "Item 1%" }, approved: false, submittedat: { gte: "2026-10-11T00:01:00.123456Z" }, neededon: { lt: "2026-10-18" }, sortbucket: { ne: "bucket-1" }, requestedunits: { in: [1, 2, 3, 4] }, created_at: { gte: "2020-01-01T00:00:00Z" } };
  for (const caller of [user(A), user(B), system, anonymous]) {
    const s = stores(caller), scoped = caller.kind !== "anonymous", ttl = caller.kind === "system" || (caller.kind === "user" && caller.subject === A);
    await same("eq-purchases-all", caller, s.purchase_requests, {}, scoped); await same("eq-purchases-filtered", caller, s.purchase_requests, purchases, scoped);
    await same("eq-notes-all", caller, s.session_notes, {}, ttl); await same("eq-notes-filtered", caller, s.session_notes, { body: { in: ["live", "forever", "gone"] }, expiresat: null }, ttl);
    await same("eq-catalog-all", caller, s.catalog_items, {}, true); await same("eq-catalog-filtered", caller, s.catalog_items, { price: { gte: 2 }, name: { ne: "pen" } }, true);
  }
  ok();

  // ---- placeholders continue after the base statement's own (uid, cutoff...), in both modes
  if (env.record) {
    const ph = (n: number) => env.sqlite ? `?${n}` : `$${n}`;
    const seen = async (caller: Caller, run: (s: ReturnType<StoreEnv["stores"]>) => Promise<unknown>) => env.record!(caller, run);
    let c = await seen(user(A), s => s.purchase_requests.find({ where: { title: "Item 1", amount: { gt: 1 } } }));
    assert.deepEqual(c.values, [A, "Item 1", 1]); assert.ok(c.sql.includes(`r."title" = ${ph(2)}`) && c.sql.includes(`r."amount" > ${ph(3)}`), c.sql);
    c = await seen(system, s => s.purchase_requests.find({ where: { title: "Item 1", amount: { gt: 1 } } }));
    assert.deepEqual(c.values, ["Item 1", 1]); assert.ok(c.sql.includes(`r."title" = ${ph(1)}`) && c.sql.includes(`r."amount" > ${ph(2)}`), c.sql);
    c = await seen(user(A), s => s.session_notes.find({ where: { body: "x" } }));
    assert.equal(c.values.length, 3); assert.ok(c.sql.includes(`r."body" = ${ph(3)}`), c.sql);
    c = await seen(system, s => s.session_notes.count({ body: "x" }));
    assert.equal(c.values.length, 2); assert.ok(c.sql.includes(`r."body" = ${ph(2)}`), c.sql);
    c = await seen(user(A), s => s.purchase_requests.findById("x")); assert.deepEqual(c.values, [A, "x"]); assert.ok(c.sql.includes(`r."id" = ${ph(2)}`));
    c = await seen(system, s => s.purchase_requests.findById("x")); assert.deepEqual(c.values, ["x"]); assert.ok(c.sql.includes(`r."id" = ${ph(1)}`));
    const page = await a.find({ orderBy: "title", limit: 5 });
    c = await seen(user(A), s => s.purchase_requests.find({ orderBy: "title", limit: 5, cursor: page.cursor, where: { title: { like: "Item%" } } }));
    const top = Math.max(...[...c.sql.matchAll(env.sqlite ? /\?(\d+)/g : /\$(\d+)/g)].map(x => Number(x[1]))); assert.equal(top, c.values.length, c.sql);
    ok();
  }
  await verifyTransactions(env, ok);
  return { checks };
}

/** Atomicity checked against the full native state, including every row in both owners' collections. */
async function verifyTransactions(env: StoreEnv, ok: () => void) {
  const store = env.store(user(A));
  const notes = store.collection("session_notes"), catalog = store.collection("catalog_items"), purchases = store.collection("purchase_requests");
  const snapshot = () => Promise.all(["purchase_requests", "session_notes", "catalog_items"].map(t => env.native(`SELECT * FROM ${t} ORDER BY id`)));
  const keep = await catalog.insert({ sku: "batch-keep", name: "before", price: 1 });
  const remove = await catalog.insert({ sku: "batch-delete", name: "remove", price: 2 });
  const write = notes.insert({ body: "batch-insert", expiresat: null });
  assert.equal(await notes.count({ body: "batch-insert" }), 0, "Write is lazy");
  const results = await store.batch([write, catalog.update(keep.id, { name: "after" }, { lock: keep.version }), catalog.delete(remove.id, { lock: remove.version })]);
  assert.equal(results[0].body, "batch-insert"); assert.equal(results[1].name, "after"); assert.equal(results[2], undefined);
  assert.equal((await notes.findById(results[0].id)).body, "batch-insert");
  assert.equal((await catalog.findById(keep.id)).name, "after"); assert.equal(await catalog.findById(remove.id), null); ok();
  await assert.rejects(store.batch([write]), /unused Writes/);
  await assert.rejects(Promise.resolve(write), /already been batched/); ok();

  const now = await catalog.findById(keep.id);
  const before = await snapshot();
  await refused(store.batch([notes.insert({ body: "stale-rollback", expiresat: null }), catalog.delete(keep.id, { lock: now.version }), purchases.update((await purchases.first()).id, { title: "stale" }, { lock: -1 })]), "CONFLICT");
  assert.deepEqual(await snapshot(), before); ok();
  const other = await env.stores(user(B)).purchase_requests.first();
  await refused(store.batch([notes.insert({ body: "scope-rollback", expiresat: null }), purchases.delete(other.id, { lock: other.version })]), "CONFLICT");
  assert.deepEqual(await snapshot(), before); ok();
  const purchase = await purchases.first();
  const duplicate = { ...purchase }; for (const c of ["id", "version", "created_at", "updated_at", "author_id"]) delete duplicate[c];
  // SQLite returns JSON text; Store JSON inputs are objects.
  if (typeof duplicate.payload === "string") duplicate.payload = JSON.parse(duplicate.payload);
  await refused(store.batch([catalog.update(keep.id, { name: "unique-rollback" }, { lock: now.version }), notes.insert({ body: "unique-rollback", expiresat: null }), purchases.insert(duplicate)]), "CONFLICT");
  assert.deepEqual(await snapshot(), before); ok();

  const single = notes.insert({ body: "await-once", expiresat: null });
  const row = await single; assert.deepEqual(await single, row);
  assert.equal(await notes.count({ body: "await-once" }), 1);
  await assert.rejects(store.batch([single]), /unused Writes/); ok();
  const repeated = notes.insert({ body: "duplicate-write", expiresat: null });
  await assert.rejects(store.batch([repeated, repeated]), /unused Writes/);
  await assert.rejects(store.batch([env.store(user(B)).collection("session_notes").insert({ body: "foreign", expiresat: null })]), /unused Writes/);
  assert.deepEqual(await store.batch([]), []); ok();

  if (!store.transaction) { assert.equal("transaction" in store, false); return; }
  const promptly = async (run: () => unknown) => {
    let timer: ReturnType<typeof setTimeout>;
    try {
      return await Promise.race([Promise.resolve().then(run), new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("Outer handle did not fail promptly")), 500);
      })]);
    } finally { clearTimeout(timer!); }
  };
  const misuseBefore = await snapshot();
  for (const run of [
    () => catalog.update(keep.id, { name: "outer-write" }, { lock: now.version }),
    () => catalog.findById(keep.id),
    () => env.view("purchase-totals", user(A), {}),
    () => env.call("create-session-note-pair", user(A), { body: "outer-procedure", expiresAt: null }),
    () => store.transaction(async () => {}),
  ]) {
    await assert.rejects(store.transaction(async (tx: any) => {
      await tx.collection("session_notes").insert({ body: "misuse-rollback", expiresat: null });
      await promptly(run);
    }), (e: any) => e?.name === "ContractError" && e.code === "INPUT_VALIDATION_FAILED" && /use tx, not the outer store/.test(e.message));
    assert.deepEqual(await snapshot(), misuseBefore); ok();
  }
  // Descendants retain ALS context after the callback: the outer handle is usable once the transaction ends.
  let after!: Promise<unknown>, releaseAfter!: () => void;
  const afterGate = new Promise<void>(resolve => { releaseAfter = resolve; });
  await store.transaction(async () => { after = afterGate.then(() => catalog.findById(keep.id)); });
  releaseAfter(); assert.equal((await after as any).name, "after"); ok();
  let escaped: any;
  const committed = await store.transaction(async (tx: any) => {
    escaped = tx;
    assert.equal("batch" in tx, false);
    const n = tx.collection("session_notes");
    const row = await n.insert({ body: "tx-commit", expiresat: null });
    assert.equal((await n.findById(row.id)).body, "tx-commit");
    const view = await tx.views["purchase-totals"]({}); assert.ok(view.length);
    const output = await tx.procedures["create-session-note-pair"]({ body: "tx-procedure-commit", expiresAt: null });
    assert.equal(output.results.length, 2);
    assert.equal(await n.count({ body: "tx-procedure-commit" }), 2);
    return row.id;
  });
  assert.equal((await notes.findById(committed)).body, "tx-commit");
  assert.equal(await notes.count({ body: "tx-procedure-commit" }), 2); ok();
  await assert.rejects(escaped.collection("session_notes").count(), /Transaction has ended/); ok();
  const rollbackBefore = await snapshot(), abort = new Error("callback failed");
  await assert.rejects(store.transaction(async (tx: any) => {
    await tx.collection("catalog_items").update(keep.id, { name: "tx-rollback" }, { lock: now.version });
    await tx.collection("session_notes").insert({ body: "tx-rollback", expiresat: null });
    await tx.procedures["create-session-note-pair"]({ body: "tx-procedure-rollback", expiresAt: null });
    throw abort;
  }), (e: any) => e === abort);
  assert.deepEqual(await snapshot(), rollbackBefore); ok();
  await assert.rejects(store.transaction(async (tx: any) => {
    await tx.collection("session_notes").insert({ body: "nested-rollback", expiresat: null });
    await tx.transaction(async () => {});
  }), /Nested transactions/);
  assert.deepEqual(await snapshot(), rollbackBefore); ok();
  if (!env.sqlite) {
    assert.equal(env.beginOptions.at(-1), "isolation level serializable");
    await store.transaction(async (tx: any) => { await tx.collection("session_notes").count(); }, { isolation: "read committed" });
    assert.equal(env.beginOptions.at(-1), "isolation level read committed");
    // the level is printed into BEGIN: anything else is refused before any SQL
    const before = env.beginOptions.length;
    await assert.rejects(store.transaction(async () => {}, { isolation: "serializable; DROP TABLE session_notes" as never }), (e: any) => e?.code === "INPUT_VALIDATION_FAILED");
    assert.equal(env.beginOptions.length, before); ok();
  } else {
    const order: string[] = [];
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(r => { release = r; }), start = new Promise<void>(r => { entered = r; });
    const first = store.transaction(async (tx: any) => {
      order.push("first-start"); entered();
      const c = tx.collection("catalog_items"), current = await c.findById(keep.id);
      await c.update(keep.id, { price: 10 }, { lock: current.version });
      await gate;
      assert.equal((await c.findById(keep.id)).price, 10);
      order.push("first-end");
    });
    await start;
    const second = env.store(user(A)).transaction(async (tx: any) => {
      order.push("second-start");
      const c = tx.collection("catalog_items"), current = await c.findById(keep.id);
      assert.equal(current.price, 10);
      await c.update(keep.id, { price: 20 }, { lock: current.version });
      order.push("second-end");
    });
    const plain = Promise.resolve(catalog.update(keep.id, { price: 30 }, { lock: Number(now.version) + 2 })).then(() => { order.push("plain"); });
    const read = catalog.findById(keep.id).then((row: any) => { assert.equal(row.price, 20); order.push("read"); });
    await Promise.resolve(); assert.deepEqual(order, ["first-start"]);
    release(); await Promise.all([first, second, plain, read]);
    assert.deepEqual(order, ["first-start", "first-end", "second-start", "second-end", "read", "plain"]);
    assert.equal((await catalog.findById(keep.id)).price, 30); ok();
  }
}
