/**
 * ADR-0046 spike: caller attributes (`auth.attr`) and attribute scope on one real driver. Same scenarios on bun:sqlite, a D1 shim,
 * Bun.SQL and postgres.js (tests/attrs.test.ts); rows are told apart by title.
 */
import { expect } from "bun:test";
import type { Caller } from "../src/kernel/contracts.js";

const system: Caller = { kind: "system", reason: "attrs-seed" };
type Attrs = NonNullable<Extract<Caller, { kind: "user" }>["attrs"]>;
/** A staff caller with the declared `sales` role and, optionally, attributes. */
export const sales = (subject: string, attrs?: Attrs, extra: object = {}): Caller =>
  ({ kind: "user", subject, role: "sales", scopes: [], credential: "session", credentialId: null, clientId: null, ...(attrs ? { attrs } : {}), ...extra }) as Caller;

const titles = (rows: { title: string }[]) => rows.map(r => r.title).sort();
const code = async (run: () => Promise<unknown>) => run().then(() => "ok", (e: any) => e?.code ?? String(e));

export async function verifyAttrs(app: any, db: any): Promise<number> {
  let checks = 0;
  const is = (actual: unknown, expected: unknown, label: string) => { try { expect(actual).toEqual(expected); } catch (e) { throw new Error(`${label}: ${(e as Error).message}`); } checks++; };
  const view = (name: string, caller: Caller) => app.views[name](db, caller, {}) as Promise<{ title: string }[]>;
  const store = (caller: Caller) => app.store(db, caller);

  // seed with a system caller (it bypasses scope): orders in TW x2, JP, US; notes in TW, JP, US
  const orders = store(system).collection("orders"), notes = store(system).collection("notes");
  for (const [region, tier, title] of [["TW", "gold", "A1"], ["TW", "silver", "A2"], ["JP", "gold", "B1"], ["US", "silver", "C1"]] as const) await orders.insert({ region, tier, title });
  for (const [area, title] of [["TW", "tw-note"], ["JP", "jp-note"], ["US", "us-note"]] as const) await notes.insert({ area, title });

  // ---- reads through a View
  is(titles(await view("regional-orders", sales("u1", { region: ["TW"] }))), ["A1", "A2"], "TW caller sees only TW rows");
  is(titles(await view("regional-orders", sales("u1", { region: ["TW", "JP"] }))), ["A1", "A2", "B1"], "multi-valued [TW, JP] sees both");
  is(titles(await view("regional-orders", sales("u1", { region: "JP" }))), ["B1"], "a scalar for a multi-valued attribute is a set of one");
  // missing / empty / mistyped: matches nothing, never everything
  is(await view("regional-orders", sales("u1")), [], "no attrs at all sees nothing");
  is(await view("regional-orders", sales("u1", {})), [], "attrs without region sees nothing");
  is(await view("regional-orders", sales("u1", { region: [] })), [], "an empty set sees nothing");
  is(await view("regional-orders", sales("u1", { region: [5] as never })), [], "a mistyped value sees nothing");
  is(await view("regional-orders", sales("u1", { region: true as never })), [], "a boolean for a string set sees nothing");
  is(await code(() => view("regional-orders", { kind: "anonymous" })), "UNAUTHENTICATED", "anonymous is refused by requires");
  is(await code(() => view("regional-orders", sales("u1", { region: ["TW"] }, { role: "editor" }))), "AUTH_DENIED", "an undeclared role string is refused by requires");
  is(titles(await view("regional-orders", sales("u1", { region: ["TW"] }, { role: null, roles: ["other", "sales"] }))), ["A1", "A2"], "roles[] decides ctx.staff when the host supplies it");
  is(await code(() => view("regional-orders", sales("u1", { region: ["TW"] }, { role: "sales", roles: ["other"] }))), "AUTH_DENIED", "roles[] wins over role");
  // a hostile value is data, never SQL
  is(await view("regional-orders", sales("u1", { region: ["TW' OR '1'='1", "x\") --"] })), [], "an injection attempt matches nothing");
  is(titles(await view("regional-orders", sales("u1", { region: ["TW", "TW", "TW"] }))), ["A1", "A2"], "duplicates in the set do not duplicate rows");
  // single-valued
  is(titles(await view("tier-orders", sales("u1", { tier: "gold" }))), ["A1", "B1"], "single-valued attribute: equality");
  is(await view("tier-orders", sales("u1")), [], "single-valued, missing: nothing");
  is(await view("tier-orders", sales("u1", { tier: ["gold"] as never })), [], "single-valued, an array: nothing (fail closed)");
  // an author-negated predicate is NULL (not true) for a missing or empty set: still nothing
  is(titles(await view("negated-orders", sales("u1", { region: ["TW"] }))), ["B1", "C1"], "negation works for a real set");
  is(await view("negated-orders", sales("u1")), [], "negation over a missing attribute: nothing");
  is(await view("negated-orders", sales("u1", { region: [] })), [], "negation over an empty set: nothing");
  // control: no attribute reference, nothing scoped
  is(titles(await view("all-orders", sales("u1"))), ["A1", "A2", "B1", "C1"], "an unscoped View is untouched");

  // ---- the staff View over an attribute-scoped Schema (scope is AND-ed into the touched Schema)
  is(titles(await view("notes-list", sales("u1", { region: ["TW"] }))), ["tw-note"], "scoped Schema read through a View: TW");
  is(titles(await view("notes-list", sales("u1", { region: ["TW", "JP"] }))), ["jp-note", "tw-note"], "scoped Schema read through a View: [TW, JP]");
  is(await view("notes-list", sales("u1")), [], "scoped Schema read through a View: missing attribute sees nothing");

  // ---- the Store over the same Schema
  const list = async (caller: Caller) => titles((await store(caller).collection("notes").find({})).rows);
  is(await list(sales("u1", { region: ["TW"] })), ["tw-note"], "Store find: TW");
  is(await list(sales("u1", { region: ["TW", "JP"] })), ["jp-note", "tw-note"], "Store find: [TW, JP]");
  is(await list(sales("u1")), [], "Store find: missing attribute");
  is(await list(sales("u1", { region: [] })), [], "Store find: empty set");
  is(await list(system), ["jp-note", "tw-note", "us-note"], "Store find: a system caller bypasses attribute scope");
  const all = (await store(system).collection("notes").find({})).rows as { id: string; title: string; version: number }[];
  const byTitle = Object.fromEntries(all.map(r => [r.title, r]));
  is(await store(sales("u1", { region: ["TW"] })).collection("notes").findById(byTitle["jp-note"]!.id), null, "Store findById outside the set is null");
  is((await store(sales("u1", { region: ["TW"] })).collection("notes").findById(byTitle["tw-note"]!.id))?.title, "tw-note", "Store findById inside the set");
  is(await store(sales("u1", { region: ["TW"] })).collection("notes").count(), 1, "Store count is scoped");
  is(Object.keys(all[0]!).includes("area"), false, "the scope column is not read back (as for identity scope)");

  // inserts: the value must be inside the caller's set
  const insert = (caller: Caller, values: object) => code(() => store(caller).collection("notes").insert(values as never));
  is(await insert(sales("u1", { region: ["TW"] }), { area: "TW", title: "new-tw" }), "ok", "insert inside the set");
  is(await insert(sales("u1", { region: ["TW"] }), { area: "JP", title: "bad-jp" }), "AUTH_DENIED", "insert outside the set is refused");
  is(await insert(sales("u1", { region: ["TW", "JP"] }), { area: "JP", title: "new-jp" }), "ok", "insert into the second value of a multi-valued set");
  is(await insert(sales("u1"), { area: "TW", title: "bad-noattr" }), "AUTH_DENIED", "insert without the attribute is refused");
  is(await insert(sales("u1", { region: [] }), { area: "TW", title: "bad-empty" }), "AUTH_DENIED", "insert with an empty set is refused");
  is(await insert(sales("u1", { region: ["TW"] }), { title: "bad-missing-area" }), "INPUT_VALIDATION_FAILED", "insert without a scope value is refused");
  is(await insert(sales("u1", { region: ["TW"] }), { area: null, title: "bad-null" }), "AUTH_DENIED", "insert of a null scope value is refused");
  is(await insert({ kind: "anonymous" }, { area: "TW", title: "bad-anon" }), "UNAUTHENTICATED", "anonymous insert is refused");
  is(await insert(system, { area: "ZZ", title: "system-zz" }), "ok", "a system caller may write any value");
  is((await store(system).collection("notes").find({})).rows.map((r: any) => r.title).sort(), ["jp-note", "new-jp", "new-tw", "system-zz", "tw-note", "us-note"], "refused inserts wrote nothing");

  // update and delete check the row first: a row outside the set is CONFLICT and untouched
  const tw = sales("u1", { region: ["TW"] });
  is(await code(() => store(tw).collection("notes").update(byTitle["jp-note"]!.id, { title: "hijack" }, { lock: byTitle["jp-note"]!.version })), "CONFLICT", "update outside the set");
  is(await code(() => store(tw).collection("notes").delete(byTitle["jp-note"]!.id, { lock: byTitle["jp-note"]!.version })), "CONFLICT", "delete outside the set");
  is(await code(() => store(tw).collection("notes").update(byTitle["tw-note"]!.id, { title: "tw-note" }, { lock: byTitle["tw-note"]!.version })), "ok", "update inside the set");
  is(await code(() => store(tw).collection("notes").update(byTitle["tw-note"]!.id, { area: "JP" } as never, { lock: byTitle["tw-note"]!.version + 1 })), "INPUT_VALIDATION_FAILED", "the scope value cannot be moved by an update");
  is((await store(system).collection("notes").findById(byTitle["jp-note"]!.id))?.title, "jp-note", "the outside row is intact");

  // ---- a Procedure's UPDATE with an attribute predicate (no scope involved)
  const a1 = ((await store(system).collection("orders").find({})).rows as { id: string; title: string }[]);
  const id = (title: string) => a1.find(r => r.title === title)!.id;
  const rename = (caller: Caller, title: string, to: string) => app.procedures["rename-order"](db, caller, { id: id(title), title: to }).then((r: any) => r.results, (e: any) => e.code ?? String(e));
  is(await rename(sales("u1", { region: ["TW"] }), "B1", "stolen"), "CONFLICT", "a Procedure UPDATE outside the set changes nothing");
  is(JSON.stringify(await rename(sales("u1", { region: ["TW"] }), "A1", "A1-renamed")).includes("A1-renamed"), true, "a Procedure UPDATE inside the set");
  is(titles((await store(system).collection("orders").find({})).rows as { title: string }[]), ["A1-renamed", "A2", "B1", "C1"], "only the in-set order was renamed");
  is(await rename(sales("u1", { region: ["TW"] }, { role: "editor" }), "A2", "x"), "AUTH_DENIED", "Procedure requires: undeclared role");
  return checks;
}
