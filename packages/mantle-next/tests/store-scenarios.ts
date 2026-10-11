/**
 * The Store on one real driver: scope, trusted mode, TTL, keyset paging, every operator, refusals, OCC, placeholder
 * continuation and wire forms, each checked against an independent model of the seeded rows and native SQL. Runs under
 * bun:test (bun:sqlite, a D1 shim, Bun.SQL) and in verify-native (the four real hosts), so it uses node:assert only.
 */
import assert from "node:assert/strict";
import type { Caller } from "../src/kernel/contracts.js";

const user = (subject: string): Caller => ({ kind: "user", subject, role: null, scopes: [], credential: "session", credentialId: null, clientId: null });
const system: Caller = { kind: "system", reason: "store-scenario" };
const anonymous: Caller = { kind: "anonymous" };
const A = "store-owner-a", B = "store-owner-b";

export interface StoreEnv {
  sqlite: boolean;
  /** The generated `stores` bound to the target's database handle for this caller. */
  stores(caller: Caller): { purchase_requests: any; session_notes: any; catalog_items: any };
  /** A generated Procedure on the same handle. */
  call(name: string, caller: Caller, input: Record<string, unknown>): Promise<any>;
  /** Independent native SQL with `?` placeholders. */
  native(sql: string, values?: readonly unknown[]): Promise<Record<string, unknown>[]>;
  /** What the driver was asked to run for one Store call (bun:test only). */
  record?(caller: Caller, run: (stores: ReturnType<StoreEnv["stores"]>) => Promise<unknown>): Promise<{ sql: string; values: unknown[] }>;
}

type Model = { requestNumber: string; title: string; amount: number; approved: boolean; requestedUnits: number; submittedAt: string; neededOn: string; sortBucket: string | null; id: string };
const model = (owner: string, i: number): Omit<Model, "id"> => ({
  requestNumber: `S-${owner}-${String(i).padStart(3, "0")}`, title: `Item ${i % 12}`, amount: (i % 7) * 2.5, approved: i % 3 === 0, requestedUnits: (i % 5) + 1,
  submittedAt: `2026-10-11T00:0${i % 9}:00.123456Z`, neededOn: `2026-10-1${2 + (i % 6)}`, sortBucket: i % 4 === 0 ? null : `bucket-${i % 3}`,
});
const ROWS = 60;
const num = (v: unknown) => Number(v);
const refused = (p: Promise<unknown>, code = "INPUT_VALIDATION_FAILED") => assert.rejects(p, (e: any) => e?.code === code, `expected ${code}`);

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
    do { const page: { rows: any[]; cursor: string | null } = await store.find({ ...q, limit, ...(cursor ? { cursor } : {}) }); out.push(...page.rows); cursor = page.cursor; assert.ok(++pages < 1000); } while (cursor);
    return out;
  };

  // ---- scope: another owner's rows do not exist for a caller
  assert.equal(await a.count({ requestNumber: { like: "S-%" } }), ROWS); ok();
  assert.equal((await a.find({ limit: 500 })).rows.every((r: any) => String(r.requestNumber).startsWith(`S-${A}-`) || String(r.requestNumber).startsWith("REQ-")), true); ok();
  const bRow = rowsB[3]!;
  assert.equal(await a.findById(bRow.id), null); ok();
  assert.equal(await a.first({ where: { id: bRow.id } }), null); ok();
  assert.equal((await a.find({ where: { id: { in: [bRow.id, rowsA[0]!.id] } } })).rows.length, 1); ok();
  await refused(a.find({ where: { ownerId: B } as never })); // the scope column is not exposed, so it cannot be named
  await refused(a.update(bRow.id, { title: "taken" }, { lock: 1 }), "CONFLICT"); ok();
  assert.equal((await b.findById(bRow.id)).title, bRow.title); ok();
  // anonymous: Core's scope predicate matches nothing; an unscoped Schema stays readable
  const anon = env.stores(anonymous);
  assert.deepEqual((await anon.purchase_requests.find()).rows, []); assert.equal(await anon.purchase_requests.count(), 0); ok();

  // ---- trusted mode: no scope predicate, both owners
  assert.equal(await sys.count({ requestNumber: { like: "S-%" } }), ROWS * 2); ok();
  assert.equal((await sys.findById(bRow.id)).title, bRow.title); ok();

  // ---- keyset paging: every column the Schema indexes, both directions, ties and NULLs, any page size
  const sorted = (rows: Model[], key: string, dir: "asc" | "desc") => [...rows].sort((x, y) => {
    const kx = (x as any)[key], ky = (y as any)[key];
    const c = kx === ky ? (x.id < y.id ? -1 : 1) : kx === null ? -1 : ky === null ? 1 : kx < ky ? -1 : 1; // NULL is the smallest value
    return dir === "asc" ? c : -c;
  }).map(r => r.id);
  for (const key of ["id", "sortBucket", "amount", "approved", "requestedUnits", "submittedAt", "neededOn", "title", "requestNumber"]) {
    const expected = (dir: "asc" | "desc") => sorted(rowsA.map(r => ({ ...r, approved: r.approved ? 1 : 0 }) as never), key, dir);
    for (const dir of ["asc", "desc"] as const) for (const limit of [1, 7, 25, 60, 500]) {
      const got = (await drain(a, { where: { requestNumber: { like: "S-%" } }, orderBy: key, order: dir }, limit)).map(r => r.id);
      assert.deepEqual(got, expected(dir), `${key} ${dir} pages of ${limit}`);
    }
  }
  ok();
  // a filter stays in force on every page, and the last page has no cursor
  const filtered = await drain(a, { where: { approved: true, sortBucket: null }, orderBy: "sortBucket" }, 3);
  assert.equal(filtered.length, rowsA.filter(r => r.approved && r.sortBucket === null).length); ok();
  const last = await a.find({ limit: ROWS }); assert.equal(last.cursor === null || last.rows.length === ROWS, true); ok();
  // a cursor belongs to its query, and a forged one cannot leave the scope
  const first = await a.find({ orderBy: "title", limit: 5 });
  await refused(a.find({ orderBy: "amount", cursor: first.cursor! })); await refused(a.find({ orderBy: "title", order: "desc", cursor: first.cursor! }));
  await refused(a.find({ cursor: "%%%" })); await refused(a.find({ cursor: btoa("[1,2]") }));
  const forged = btoa(JSON.stringify(["purchase_requests", "id", "asc", bRow.id, bRow.id]));
  assert.ok((await a.find({ cursor: forged, limit: 500 })).rows.every((r: any) => !rowsB.some(x => x.id === r.id))); ok();

  // ---- operators
  const n = (where: Record<string, unknown>) => a.count({ requestNumber: { like: "S-%" }, ...where });
  const m = (f: (x: Model) => boolean) => rowsA.filter(f).length;
  assert.equal(await n({ sortBucket: null }), m(x => x.sortBucket === null));
  assert.equal(await n({ sortBucket: { isNull: true } }), m(x => x.sortBucket === null));
  assert.equal(await n({ sortBucket: { isNull: false } }), m(x => x.sortBucket !== null));
  assert.equal(await n({ sortBucket: { eq: null } }), m(x => x.sortBucket === null));
  assert.equal(await n({ sortBucket: { ne: null } }), m(x => x.sortBucket !== null));
  assert.equal(await n({ sortBucket: { ne: "bucket-1" } }), m(x => x.sortBucket !== null && x.sortBucket !== "bucket-1")); // SQL <>: NULL rows do not match
  assert.equal(await n({ sortBucket: { in: ["bucket-1", "bucket-2"] } }), m(x => x.sortBucket === "bucket-1" || x.sortBucket === "bucket-2"));
  assert.equal(await n({ sortBucket: { notIn: ["bucket-1"] } }), m(x => x.sortBucket !== null && x.sortBucket !== "bucket-1"));
  assert.equal(await n({ sortBucket: { in: [] } }), 0); assert.equal(await n({ sortBucket: { notIn: [] } }), ROWS);
  assert.equal(await n({ title: { like: "Item 1%" } }), m(x => x.title.startsWith("Item 1")));
  assert.equal(await n({ title: { like: "Item _" } }), m(x => /^Item \d$/.test(x.title)));
  assert.equal(await n({ amount: { gte: 5, lt: 12.5 } }), m(x => x.amount >= 5 && x.amount < 12.5));
  assert.equal(await n({ amount: { gt: 5, lte: 12.5 } }), m(x => x.amount > 5 && x.amount <= 12.5));
  assert.equal(await n({ amount: { eq: 2.5 } }), m(x => x.amount === 2.5)); assert.equal(await n({ amount: { ne: 2.5 } }), m(x => x.amount !== 2.5));
  assert.equal(await n({ approved: true }), m(x => x.approved)); assert.equal(await n({ approved: { ne: true } }), m(x => !x.approved));
  assert.equal(await n({ requestedUnits: { in: [1, 2, 99] } }), m(x => x.requestedUnits <= 2));
  assert.equal(await n({ submittedAt: { gte: "2026-10-11T00:04:00.123456Z" } }), m(x => x.submittedAt >= "2026-10-11T00:04:00.123456Z"));
  assert.equal(await n({ submittedAt: new Date("2026-10-11T00:03:00.123Z") }), 0); // Date works; microseconds differ
  assert.equal(await n({ submittedAt: { lt: new Date("2026-10-11T00:03:00.200Z") } }), m(x => x.submittedAt < "2026-10-11T00:03:00.200000Z"));
  assert.equal(await n({ neededOn: "2026-10-13" }), m(x => x.neededOn === "2026-10-13")); assert.equal(await n({ neededOn: { in: ["2026-10-12", "2026-10-15"] } }), m(x => x.neededOn === "2026-10-12" || x.neededOn === "2026-10-15"));
  assert.equal(await n({ title: "Item 3", amount: 2.5, approved: false }), m(x => x.title === "Item 3" && x.amount === 2.5 && !x.approved));
  assert.equal(await a.count({ createdAt: { gte: "2020-01-01T00:00:00Z" }, requestNumber: { like: "S-%" } }), ROWS); ok();

  // ---- refusals: only declared columns, operators and shapes reach SQL
  const hostile = "'; DROP TABLE purchase_requests; --";
  await refused(a.find({ where: { [hostile]: 1 } as never })); await refused(a.find({ where: { title: { "= 1 OR 1=1 --": 1 } } as never }));
  await refused(a.find({ where: { payload: "x" } as never })); await refused(a.find({ where: { title: undefined } as never }));
  await refused(a.find({ where: { title: { like: 5 } } as never })); await refused(a.find({ where: { amount: { like: "1%" } } as never }));
  await refused(a.find({ where: { amount: { gt: null } } as never })); await refused(a.find({ where: { title: { in: "x" } } as never }));
  await refused(a.find({ where: { title: { isNull: "yes" } } as never })); await refused(a.find({ where: { approved: "true" } as never }));
  await refused(a.find({ where: { title: { a: 1 } } as never })); await refused(a.find({ where: { title: {} } as never }));
  await refused(a.find({ orderBy: "payload" as never })); await refused(a.find({ orderBy: "version" as never })); await refused(a.find({ orderBy: hostile as never }));
  await refused(a.find({ order: "sideways" as never })); await refused(a.find({ limit: 0 })); await refused(a.find({ limit: 501 })); await refused(a.find({ limit: 1.5 }));
  await refused(a.findById({} as never)); await refused(a.update("x", { ownerId: B } as never, { lock: 1 })); await refused(a.update("x", { version: 9 } as never, { lock: 1 }));
  await refused(a.update("x", { id: "y" } as never, { lock: 1 })); await refused(a.update("x", {}, { lock: 1 })); await refused(a.update("x", { title: "t" }, { lock: "1; DROP" as never })); await refused(a.update("x", { title: undefined } as never, { lock: 1 }));
  assert.equal((await a.find({ where: { title: hostile } })).rows.length, 0);
  assert.equal(num((await env.native("SELECT COUNT(*) AS c FROM purchase_requests WHERE requestnumber LIKE ?", ["S-%"]))[0]!.c), ROWS * 2); ok();

  // ---- wire forms: ISO UTC with six digits and plain dates from SQL itself; booleans and JSON are the driver's own
  const r = (await a.first({ where: { requestNumber: rowsA[1]!.requestNumber } }))!;
  assert.equal(r.submittedAt, rowsA[1]!.submittedAt); assert.equal(r.neededOn, rowsA[1]!.neededOn); assert.match(r.createdAt, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/);
  assert.equal(r.approved, env.sqlite ? 0 : false); assert.deepEqual(env.sqlite ? JSON.parse(r.payload) : r.payload, { n: r.requestNumber });
  assert.deepEqual(await a.findById(r.id), r); ok();
  const direct = (await env.native("SELECT requestnumber FROM purchase_requests WHERE id = ?", [r.id]))[0]!; assert.equal(direct.requestnumber, r.requestNumber); ok();

  // ---- update: scope + explicit OCC, one statement, the new row back
  const u = await a.update(r.id, { title: "renamed", amount: 99.5, approved: true, submittedAt: "2027-01-02T03:04:05.654321Z", neededOn: "2027-02-03", payload: { a: 1 }, sortBucket: null }, { lock: r.version });
  assert.equal(u.title, "renamed"); assert.equal(num(u.amount), 99.5); assert.equal(num(u.version), num(r.version) + 1); assert.equal(u.submittedAt, "2027-01-02T03:04:05.654321Z"); assert.equal(u.neededOn, "2027-02-03");
  assert.equal(u.sortBucket, null); assert.equal(u.approved, env.sqlite ? 1 : true); assert.deepEqual(env.sqlite ? JSON.parse(u.payload) : u.payload, { a: 1 }); assert.equal(u.requestNumber, r.requestNumber); ok();
  assert.deepEqual(await a.findById(r.id), u); ok();
  await refused(a.update(r.id, { title: "stale" }, { lock: r.version }), "CONFLICT"); assert.equal((await a.findById(r.id)).title, "renamed"); ok();
  await refused(a.update("no-such-id", { title: "t" }, { lock: 1 }), "CONFLICT"); ok();
  const keep = await a.update(r.id, { title: "only title" }, { lock: u.version }); assert.equal(keep.amount, u.amount); assert.equal(keep.submittedAt, u.submittedAt); assert.deepEqual(env.sqlite ? JSON.parse(keep.payload) : keep.payload, { a: 1 }); ok();
  await a.update(r.id, { sortBucket: "back" }, { lock: keep.version }); ok();
  // the trusted write has no scope predicate; the foreign row moves from its own version
  const owned = (await b.findById(bRow.id)), moved = await sys.update(bRow.id, { title: "system edit" }, { lock: owned.version });
  assert.equal(moved.title, "system edit"); assert.equal((await b.findById(bRow.id)).title, "system edit"); ok();
  assert.equal(num((await env.native("SELECT COUNT(*) AS c FROM purchase_requests WHERE title = ?", ["system edit"]))[0]!.c), 1); ok();

  // ---- TTL (Core's cutoff bind sits after the uid bind) and an unscoped Schema
  const hour = 3_600_000, at = (ms: number) => new Date(Date.now() + ms).toISOString();
  for (const [body, expiresAt] of [["live", at(hour)], ["forever", null], ["gone", at(-hour)]] as const) await env.call("create-session-note", user(A), { body, expiresAt });
  const notes = env.stores(user(A)).session_notes;
  assert.deepEqual((await notes.find({ orderBy: "body" })).rows.map((x: any) => x.body), ["forever", "live"]); ok();
  assert.deepEqual((await env.stores(system).session_notes.find({ orderBy: "body", where: { body: { in: ["live", "forever", "gone"] } } })).rows.map((x: any) => x.body), ["forever", "live"]); ok();
  assert.equal((await env.stores(user(B)).session_notes.find()).rows.length, 0);
  const live = (await notes.first({ where: { body: "live" } }))!;
  assert.ok((await notes.update(live.id, { expiresAt: null }, { lock: live.version })).expiresAt === null); ok();
  assert.equal((await env.native("SELECT id FROM session_notes WHERE body = ?", ["gone"])).length, 1);
  for (const [sku, name, price] of [["c-1", "pen", 1.5], ["c-2", "ink", 4], ["c-3", "pad", 2]] as const) await env.call("create-catalog-item", user(A), { sku, name, price });
  const catalog = (caller: Caller) => env.stores(caller).catalog_items;
  for (const caller of [user(A), user(B), anonymous, system]) assert.deepEqual((await catalog(caller).find({ orderBy: "name" })).rows.map((x: any) => x.name), ["ink", "pad", "pen"]);
  await refused(catalog(user(A)).find({ orderBy: "price" as never })); // not indexed: refused rather than sorted without an index
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
    const page = await a.find({ orderBy: "sortBucket", limit: 5 });
    c = await seen(user(A), s => s.purchase_requests.find({ orderBy: "sortBucket", limit: 5, cursor: page.cursor, where: { title: { like: "Item%" } } }));
    const top = Math.max(...[...c.sql.matchAll(env.sqlite ? /\?(\d+)/g : /\$(\d+)/g)].map(x => Number(x[1]))); assert.equal(top, c.values.length, c.sql);
    ok();
  }
  return { checks };
}
