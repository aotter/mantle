/** Shared native user-field scenarios; node:assert also runs in the native harness. */
import assert from "node:assert/strict";
import type { Caller } from "../src/kernel/contracts.js";

const system: Caller = { kind: "system", reason: "attrs-seed" };
type Fields = Readonly<Record<string, string | number | readonly (string | number)[] | { readonly all: true }>>;
type MakeCaller = typeof import("../src/kernel/user-caller.js").userCaller;

const titles = (rows: { title: string }[]) => rows.map(r => r.title).sort();
const code = async (run: () => Promise<unknown>) => run().then(() => "ok", (e: any) => e?.code ?? String(e));

export async function verifyUserFields(app: any, db: any, makeCaller: MakeCaller): Promise<number> {
  const sales = (id: string, values: Fields = {}, extra: Record<string, unknown> = {}): Caller => makeCaller(
    { id, role: "sales", ...values, ...extra },
    { fields: { region: { type: "string", multiple: true }, tier: { type: "string", multiple: false } }, adminRoles: extra.admin === false ? [] : ["sales"] });
  let checks = 0;
  // plain JSON on purpose: postgres.js results are Array subclasses
  const is = (actual: unknown, expected: unknown, label: string) => { assert.deepEqual(JSON.parse(JSON.stringify(actual ?? null)), expected, label); checks++; };
  const view = (name: string, caller: Caller) => app.views[name](db, caller, {}) as Promise<{ title: string }[]>;
  const store = (caller: Caller) => app.store(db, caller);

  const orders = store(system).collection("orders"), notes = store(system).collection("notes");
  for (const [region, tier, title] of [["TW", "gold", "A1"], ["TW", "silver", "A2"], ["JP", "gold", "B1"], ["US", "silver", "C1"]] as const) await orders.insert({ region, tier, title });
  for (const [area, title] of [["TW", "tw-note"], ["JP", "jp-note"], ["US", "us-note"]] as const) await notes.insert({ area, title });

  is(titles(await view("regional-orders", sales("u1", { region: ["TW"] }))), ["A1", "A2"], "TW caller sees only TW rows");
  is(await code(() => view("regional-orders", { ...sales("u1", { region: ["TW"] }) })), "AUTH_DENIED", "copied callers cannot bind restrict values");
  is(titles(await view("regional-orders", sales("u1", { region: ["TW", "JP"] }))), ["A1", "A2", "B1"], "multi-valued [TW, JP] sees both");
  is(titles(await view("regional-orders", sales("u1", { region: "JP" }))), ["B1"], "a scalar for a multi-valued attribute is a set of one");
  // missing / empty / mistyped: refused in code before SQL, never everything
  is(await code(() => view("regional-orders", sales("u1"))), "AUTH_DENIED", "no attrs at all is refused");
  is(await code(() => view("regional-orders", sales("u1", { region: [] }))), "AUTH_DENIED", "an empty set is refused");
  is(await code(async () => view("regional-orders", sales("u1", { region: [5] as never }))), "USER_FIELD_INVALID", "a mistyped value is rejected before binding");
  is(await code(async () => view("regional-orders", sales("u1", { region: true as never }))), "USER_FIELD_INVALID", "a boolean for a string set is rejected before binding");
  is(await code(() => view("regional-orders", { kind: "anonymous" })), "UNAUTHENTICATED", "anonymous is refused by requires");
  is(await code(() => view("regional-orders", sales("u1", { region: ["TW"] }, { role: "editor" }))), "AUTH_DENIED", "an undeclared role string is refused by requires");
  is(titles(await view("regional-orders", sales("u1", { region: ["TW"] }, { role: "other,sales" }))), ["A1", "A2"], "roles[] decides ctx.admin when the host supplies it");
  is(await code(() => view("regional-orders", sales("u1", { region: ["TW"] }, { role: "other" }))), "AUTH_DENIED", "roles[] wins over role");
  // a hostile value is data, never SQL
  is(await view("regional-orders", sales("u1", { region: ["TW' OR '1'='1", "x\") --"] })), [], "an injection attempt matches nothing");
  is(titles(await view("regional-orders", sales("u1", { region: ["TW", "TW", "TW"] }))), ["A1", "A2"], "duplicates in the set do not duplicate rows");
  // single-valued
  is(titles(await view("tier-orders", sales("u1", { tier: "gold" }))), ["A1", "B1"], "single-valued attribute: equality");
  is(await code(() => view("tier-orders", sales("u1"))), "AUTH_DENIED", "single-valued, missing: refused");
  is(await code(async () => view("tier-orders", sales("u1", { tier: ["gold"] }))), "USER_FIELD_INVALID", "single-valued, an array: refused");
  // control: no attribute reference, nothing scoped
  is(titles(await view("all-orders", sales("u1"))), ["A1", "A2", "B1", "C1"], "an unscoped View is untouched");

  is(titles(await view("notes-list", sales("u1", { region: ["TW"] }))), ["tw-note"], "scoped Schema read through a View: TW");
  is(titles(await view("notes-list", sales("u1", { region: ["TW", "JP"] }))), ["jp-note", "tw-note"], "scoped Schema read through a View: [TW, JP]");
  is(await code(() => view("notes-list", sales("u1"))), "AUTH_DENIED", "scoped Schema read through a View: missing attribute is refused");

  const list = async (caller: Caller) => titles((await store(caller).collection("notes").find({})).rows);
  is(await list(sales("u1", { region: ["TW"] })), ["tw-note"], "Store find: TW");
  is(await list(sales("u1", { region: ["TW", "JP"] })), ["jp-note", "tw-note"], "Store find: [TW, JP]");
  is(await code(() => list(sales("u1"))), "AUTH_DENIED", "Store find: missing attribute");
  is(await code(() => list(sales("u1", { region: [] }))), "AUTH_DENIED", "Store find: empty set");
  is(await list(system), ["jp-note", "tw-note", "us-note"], "Store find: a system caller bypasses attribute scope");
  const all = (await store(system).collection("notes").find({})).rows as { id: string; title: string; version: number }[];
  const byTitle = Object.fromEntries(all.map(r => [r.title, r]));
  is(await store(sales("u1", { region: ["TW"] })).collection("notes").findById(byTitle["jp-note"]!.id), null, "Store findById outside the set is null");
  is((await store(sales("u1", { region: ["TW"] })).collection("notes").findById(byTitle["tw-note"]!.id))?.title, "tw-note", "Store findById inside the set");
  is(await store(sales("u1", { region: ["TW"] })).collection("notes").count(), 1, "Store count is scoped");
  is(Object.keys(all[0]!).includes("area"), true, "the field scope remains a native application column");

  // inserts: the value must be inside the caller's set
  const insert = (caller: Caller, values: object) => code(() => store(caller).collection("notes").insert(values as never));
  is(await insert(sales("u1", { region: ["TW"] }), { area: "TW", title: "new-tw" }), "ok", "insert inside the set");
  is(await insert(sales("u1", { region: ["TW"] }), { area: "JP", title: "bad-jp" }), "AUTH_DENIED", "insert outside the set is refused");
  is(await insert(sales("u1", { region: ["TW", "JP"] }), { area: "JP", title: "new-jp" }), "ok", "insert into the second value of a multi-valued set");
  is(await insert(sales("u1"), { area: "TW", title: "bad-noattr" }), "AUTH_DENIED", "insert without the attribute is refused");
  is(await insert(sales("u1", { region: [] }), { area: "TW", title: "bad-empty" }), "AUTH_DENIED", "insert with an empty set is refused");
  is(await insert(sales("u1", { region: ["TW"] }), { title: "auto-tw" }), "ok", "a single scope value is auto-filled");
  is(await insert(sales("u1", { region: ["TW"] }), { area: null, title: "bad-null" }), "AUTH_DENIED", "insert of a null scope value is refused");
  is(await insert({ kind: "anonymous" }, { area: "TW", title: "bad-anon" }), "UNAUTHENTICATED", "anonymous field-scoped insert is refused");
  is(await insert(system, { area: "ZZ", title: "system-zz" }), "ok", "a system caller may write any value");
  is((await store(system).collection("notes").find({})).rows.map((r: any) => r.title).sort(), ["auto-tw", "jp-note", "new-jp", "new-tw", "system-zz", "tw-note", "us-note"], "refused inserts wrote nothing");

  // update and delete check the row first: a row outside the set is CONFLICT and untouched
  const tw = sales("u1", { region: ["TW"] });
  is(await code(() => store(tw).collection("notes").update(byTitle["jp-note"]!.id, { title: "hijack" }, { lock: byTitle["jp-note"]!.version })), "CONFLICT", "update outside the set");
  is(await code(() => store(tw).collection("notes").delete(byTitle["jp-note"]!.id, { lock: byTitle["jp-note"]!.version })), "CONFLICT", "delete outside the set");
  is(await code(() => store(tw).collection("notes").update(byTitle["tw-note"]!.id, { title: "tw-note" }, { lock: byTitle["tw-note"]!.version })), "ok", "update inside the set");
  is(await code(() => store(tw).collection("notes").update(byTitle["tw-note"]!.id, { area: "JP" } as never, { lock: byTitle["tw-note"]!.version + 1 })), "INPUT_VALIDATION_FAILED", "the scope value cannot be moved by an update");
  is((await store(system).collection("notes").findById(byTitle["jp-note"]!.id))?.title, "jp-note", "the outside row is intact");

  const a1 = ((await store(system).collection("orders").find({})).rows as { id: string; title: string }[]);
  const id = (title: string) => a1.find(r => r.title === title)!.id;
  const rename = (caller: Caller, title: string, to: string) => app.procedures["rename-order"](db, caller, { id: id(title), title: to }).then((r: any) => r.results, (e: any) => e.code ?? String(e));
  is(await rename(sales("u1", { region: ["TW"] }), "B1", "stolen"), "CONFLICT", "a Procedure UPDATE outside the set changes nothing");
  is(JSON.stringify(await rename(sales("u1", { region: ["TW"] }), "A1", "A1-renamed")).includes("A1-renamed"), true, "a Procedure UPDATE inside the set");
  is(titles((await store(system).collection("orders").find({})).rows as { title: string }[]), ["A1-renamed", "A2", "B1", "C1"], "only the in-set order was renamed");
  is(await rename(sales("u1", { region: ["TW"] }, { role: "editor" }), "A2", "x"), "AUTH_DENIED", "Procedure requires: undeclared role");

  const odd = `q"u\\o,te{} 'x'`;
  await store(system).collection("orders").insert({ region: odd, tier: "gold", title: "W1" });
  is(titles(await view("regional-orders", sales("u1", { region: [odd, "TW"] }))), ["A1-renamed", "A2", "W1"], "a value with quotes, backslash, comma and braces matches exactly");
  is(titles(await view("regional-orders", sales("u1", { region: ["TW"] }))), ["A1-renamed", "A2"], "and is not matched by its neighbours");
  is(await code(async () => view("notes-list", { ...sales("u1", { region: ["TW"] }) })), "AUTH_DENIED", "copied authority fails closed");
  is(await code(async () => view("notes-list", sales("u1", { region: ["TW"] }, { admin: false }))), "AUTH_DENIED", "a member holding sales does not gain the admin layer");
  for (const value of ["NULL", "null", "  TW  ", "},{", "x".repeat(256), "界".repeat(85)]) {
    await store(system).collection("orders").insert({ region: value, tier: "encoding", title: "encoded:" + value });
    is(titles(await view("regional-orders", sales("u1", { region: [value] }))), ["encoded:" + value], "the array element round-trips exactly");
  }
  for (const region of ["", "\uD800", "\0", "x".repeat(257), "界".repeat(86), Array(65).fill("TW")])
    is(await code(async () => view("regional-orders", sales("u1", { region } as never))), "USER_FIELD_INVALID", "invalid field values fail before binding");
  is(titles(await view("regional-orders", sales("u1", { region: Array(64).fill("TW") }))), ["A1-renamed", "A2"], "64 elements accepted and deduplicated");
  const everyRegion = sales("all", { region: { all: true } });
  is((await list(everyRegion)).length, 7, "{ all: true } reads every partition through the Store");
  is((await view("notes-list", everyRegion)).length, 7, "and through a View");
  is((await store(everyRegion).collection("notes").findById(byTitle["jp-note"]!.id))?.title, "jp-note", "findById reaches another partition");
  is(await code(() => view("regional-orders", everyRegion)), "AUTH_DENIED", "a restrict term refuses { all: true }");
  is(await code(() => store({ ...everyRegion }).collection("notes").count()), "AUTH_DENIED", "copying cannot preserve { all: true }");
  is(await insert(everyRegion, { title: "no-area" }), "INPUT_VALIDATION_FAILED", "{ all: true } must name the partition it writes");
  is(await insert(everyRegion, { area: "JP", title: "all-jp" }), "ok", "an explicit partition is written");
  is(await code(() => store(everyRegion).collection("notes").update(byTitle["jp-note"]!.id, { area: "TW" } as never, { lock: byTitle["jp-note"]!.version })), "INPUT_VALIDATION_FAILED", "even { all: true } cannot SET the partition");
  return checks;
}
