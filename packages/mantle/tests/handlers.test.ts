import { fixtureCaller } from "./apps/fixtures.js";
import { beforeAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import ts from "typescript";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { generateOrThrow, loadGenerated, writeGenerated } from "./apps/link.js";
import { user } from "./apps/fixtures.js";

const schema = `apiVersion: cms.mantle.aotter.net/v2
kind: Schema
metadata: {name: notes}
spec:
  title: Notes
  lifecycle: operational
  scope: "owner = auth.uid()"
  indexes: [[owner]]
  schema:
    type: object
    required: [owner, title]
    properties: {owner: {type: string}, title: {type: string}}
---
apiVersion: cms.mantle.aotter.net/v2
kind: View
metadata: {name: notes-list}
spec:
  surface: internal
  sql: SELECT title FROM notes ORDER BY id
---
`;
const ref = `apiVersion: cms.mantle.aotter.net/v2
kind: Procedure
metadata: {name: app-note}
spec:
  requires: {auth: {all: [ctx.user, ctx.admin, {ctx.auth.scope: notes:write}]}}
  input: {type: object, required: [title], properties: {title: {type: string}}, additionalProperties: false}
  output: {type: object, required: [title], properties: {title: {type: string}}, additionalProperties: false}
  handler: {ref: app.createNote}
`;
beforeAll(() => mkdir(resolve(import.meta.dir, "apps/.generated"), { recursive: true }));
const targets = ["bun-sqlite", "bun-postgres", "cloudflare-d1", "cloudflare-postgres"] as const;
const caller = fixtureCaller({ ...user("writer"), role: "admin" as const, admin: true, scopes: ["notes:write"] });
const files = (target: typeof targets[number], text = schema + ref) => generateOrThrow(target, [{ sourceId: "handlers.yaml", text }]);

for (const target of ["bun-sqlite"] as const) test(`${target} caller-owned handlers gate dispatch and preserve context/errors`, async () => {
  const generated = await files(target);
  const app = await loadGenerated(generated["generated.ts"]!);
  const db = {};
  for (const denied of [{ kind: "anonymous" }, { kind: "system", reason: "test" }, user("admin"), fixtureCaller({ ...caller, scopes: [] })]) {
    await expect(app.store(db, denied, { handlers: {} }).procedures["app-note"]({ title: "t" })).rejects.toMatchObject({ code: denied.kind === "user" ? "AUTH_DENIED" : "UNAUTHENTICATED" });
  }
  for (const options of [undefined, { handlers: {} }]) {
    await expect(app.store(db, caller, options).procedures["app-note"]({ title: "t" })).rejects.toMatchObject({ code: "HANDLER_NOT_REGISTERED", path: "procedures/app-note" });
  }
  let called = 0;
  const error = new Error("application failure");
  const handlers = { "app-note": async (ctx: any, input: { title: string }) => {
    called++;
    expect(ctx.caller).toBe(caller);
    expect(ctx.db).toBe(db);
    expect(ctx.store).toBe(data);
    expect(typeof ctx.store.collection).toBe("function");
    expect(typeof ctx.store.views["notes-list"]).toBe("function");
    expect(typeof ctx.store.procedures["app-note"]).toBe("function");
    if (input.title === "throw") throw error;
    return input;
  } };
  const data = app.store(db, caller, { handlers });
  expect(Object.hasOwn(app.procedures, "app-note")).toBe(false);
  expect(app.bindHandlers).toBeUndefined();
  const other = app.store(db, caller, { handlers: { "app-note": async () => ({ title: "other" }) } });
  expect(await other.procedures["app-note"]({ title: "t" })).toEqual({ title: "other" });
  const result = { title: "t" };
  expect(await data.procedures["app-note"](result)).toBe(result);
  expect(await data.procedures["app-note"](result)).toBe(result);
  await expect(data.procedures["app-note"]({ title: "throw" })).rejects.toBe(error);
  await expect(app.store(db, fixtureCaller({ ...caller, scopes: [] }), { handlers }).procedures["app-note"](result)).rejects.toMatchObject({ code: "AUTH_DENIED" });
  expect(called).toBe(3);
});

test("ref context Store applies the same caller's scope on a real SQLite handle", async () => {
  const generated = await files("bun-sqlite");
  const app = await loadGenerated(generated["generated.ts"]!);
  const db = new Database(":memory:");
  try {
    db.exec(generated["schema.sql"]!);
    await app.store(db, user("other"), { handlers: {} }).collection("notes").insert({ title: "private" });
    const handlers = { "app-note": async ({ store }: any, input: { title: string }) => {
      expect(await store.collection("notes").count()).toBe(0);
      const row = await store.collection("notes").insert(input);
      expect(await store.views["notes-list"]({})).toEqual([{ title: input.title }]);
      return { title: row.title };
    } };
    const data = app.store(db, caller, { handlers });
    expect(await data.procedures["app-note"]({ title: "mine" })).toEqual({ title: "mine" });
    expect(db.query("SELECT owner, title FROM notes ORDER BY title").all()).toEqual([{ owner: "writer", title: "mine" }, { owner: "other", title: "private" }]);
  } finally { db.close(); }
});

test("transaction ref context is the tx Store and handle, and both write paths roll back", async () => {
  const generated = await files("bun-sqlite");
  const app = await loadGenerated(generated["generated.ts"]!);
  const db = new Database(":memory:");
  let txStore: any;
  try {
    db.exec(generated["schema.sql"]!);
    const data = app.store(db, caller, { handlers: { "app-note": async (ctx: any, input: { title: string }) => {
      expect(ctx.store).toBe(txStore);
      expect(ctx.db).not.toBe(db);
      expect(ctx.caller).toBe(caller);
      await ctx.store.collection("notes").insert(input);
      ctx.db.query("UPDATE notes SET title = 'raw tx write' WHERE title = 'before'").run();
      expect(await ctx.store.collection("notes").count()).toBe(2);
      return input;
    } } });
    await data.collection("notes").insert({ title: "before" });
    const failure = new Error("rollback callback");
    await expect(data.transaction(async (tx: any) => {
      txStore = tx;
      expect(await tx.procedures["app-note"]({ title: "ref tx write" })).toEqual({ title: "ref tx write" });
      expect((await tx.views["notes-list"]({})).map((row: any) => row.title).sort()).toEqual(["raw tx write", "ref tx write"]);
      throw failure;
    })).rejects.toBe(failure);
    expect(db.query("SELECT title FROM notes").all()).toEqual([{ title: "before" }]);
  } finally { db.close(); }
});

test("ref-only manifests need no Schema or SQL, and direct SQL reads shake handlers out", async () => {
  const app = await loadGenerated((await files("cloudflare-d1", ref))["generated.ts"]!);
  const handlers = { "app-note": async ({ caller: same }: any, input: unknown) => { expect(same).toBe(caller); return input; } };
  expect(await app.store({}, caller, { handlers }).procedures["app-note"]({ title: "t" })).toEqual({ title: "t" });
  const dir = await mkdtemp(resolve(import.meta.dir, "apps/.generated/handlers-bundle-"));
  try {
    await writeGenerated(dir, await files("cloudflare-d1"), false);
    const bundle = await Bun.build({ entrypoints: [resolve(dir, "views/notes-list.ts")], target: "browser", minify: true });
    expect(bundle.success).toBe(true);
    const code = await bundle.outputs[0]!.text();
    expect(code).not.toMatch(/HANDLER_NOT_REGISTERED|app-note|createStore|app\.createNote/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("an inherited object member is never a registered handler", async () => {
  const app = await loadGenerated((await files("bun-sqlite", ref.replace("name: app-note", "name: constructor")))["generated.ts"]!);
  for (const handlers of [{}, Object.create({ constructor: async () => ({ title: "wrong" }) })]) {
    await expect(app.store({}, caller, { handlers }).procedures.constructor({ title: "t" })).rejects.toMatchObject({ code: "HANDLER_NOT_REGISTERED" });
  }
});

test("all four Store wiring points reject missing, extra and wrong handlers", async () => {
  const dir = await mkdtemp(resolve(import.meta.dir, "apps/.generated/handlers-types-"));
  try {
    const roots: string[] = [];
    for (const target of targets) {
      const destination = resolve(dir, target);
      await writeGenerated(destination, await files(target), false);
      const consumer = resolve(destination, "consumer.ts");
      await writeFile(consumer, `import { type Handlers, procedures, store } from "./generated.js";
const good: Handlers = { "app-note": async (ctx, input) => {
  await ctx.store.views["notes-list"]({});
  const [row] = await ctx.store.batch([ctx.store.collection("notes").insert(input)]);
  const title: string = row.title;
  return { title };
} };
async function check(db: Parameters<typeof store>[0], caller: Parameters<typeof store>[1]) {
  const title: string = (await store(db, caller, { handlers: good }).procedures["app-note"]({ title: "t" })).title;
  // @ts-expect-error handlers required at wiring point
  store(db, caller);
  // @ts-expect-error options must supply handlers
  store(db, caller, {});
  // @ts-expect-error missing implementation
  store(db, caller, { handlers: {} });
  // @ts-expect-error excess implementation
  store(db, caller, { handlers: { ...good, extra: async () => ({ title: "t" }) } });
  const extra = { ...good, extra: async () => ({ title: "t" }) };
  // @ts-expect-error excess variable implementation
  store(db, caller, { handlers: extra });
  // @ts-expect-error wrong input
  store(db, caller, { handlers: { "app-note": async (ctx, input: { title: number }) => ({ title: "t" }) } });
  // @ts-expect-error wrong output
  store(db, caller, { handlers: { "app-note": async () => ({ title: 1 }) } });
  // @ts-expect-error handler must return Promise
  store(db, caller, { handlers: { "app-note": () => ({ title: "t" }) } });
  // @ts-expect-error ref Procedures only in Store map
  procedures["app-note"];
  // @ts-expect-error title required
  await store(db, caller, { handlers: good }).procedures["app-note"]({});
}
`);
      roots.push(consumer);
    }
    const plain = resolve(dir, "plain");
    await writeGenerated(plain, await files("bun-sqlite", schema.slice(0, -4)), false);
    const consumer = resolve(plain, "consumer.ts");
    await writeFile(consumer, `import { store } from "./generated.js";
function check(db: Parameters<typeof store>[0], caller: Parameters<typeof store>[1]) {
  store(db, caller);
  // App wiring is the same with or without ref Procedures: an empty Handlers object is accepted.
  store(db, caller, { handlers: {} });
}`);
    roots.push(consumer);
    const program = ts.createProgram(roots, { strict: true, noEmit: true, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, skipLibCheck: true, types: ["node", "bun-types"], typeRoots: [resolve(import.meta.dir, "../node_modules/@types"), resolve(import.meta.dir, "../node_modules")] });
    expect(ts.getPreEmitDiagnostics(program).map(d => `${d.file?.fileName} TS${d.code} ${ts.flattenDiagnosticMessageText(d.messageText, " ")}`).join("\n")).toBe("");
  } finally { await rm(dir, { recursive: true, force: true }); }
}, 15_000);

test("ctx.transaction makes a handler's writes atomic, joins an outer transaction, and is absent on D1", async () => {
  const generated = await files("bun-sqlite");
  const app = await loadGenerated(generated["generated.ts"]!);
  const db = new Database(":memory:");
  const failure = new Error("second write failed");
  const titles = () => db.query("SELECT title FROM notes ORDER BY title").all().map((r: any) => r.title);
  try {
    db.exec(generated["schema.sql"]!);
    const handlers = { "app-note": async (ctx: any, input: { title: string }) => {
      const write = async ({ store }: { store: any }) => {
        await store.collection("notes").insert(input);
        if (input.title.startsWith("fail")) throw failure;
        return input;
      };
      return input.title.endsWith("plain") ? write(ctx) : ctx.transaction(write);
    } };
    const data = app.store(db, caller, { handlers });
    // Without ctx.transaction a handler's writes are not atomic: the first one stays.
    await expect(data.procedures["app-note"]({ title: "fail plain" })).rejects.toBe(failure);
    await expect(data.procedures["app-note"]({ title: "fail tx" })).rejects.toBe(failure);
    expect(await data.procedures["app-note"]({ title: "ok tx" })).toEqual({ title: "ok tx" });
    expect(titles()).toEqual(["fail plain", "ok tx"]);
    // Called inside a caller's transaction, ctx.transaction joins it instead of refusing a nested one.
    await expect(data.transaction(async (tx: any) => { await tx.procedures["app-note"]({ title: "joined" }); throw failure; })).rejects.toBe(failure);
    expect(titles()).toEqual(["fail plain", "ok tx"]);
  } finally { db.close(); }
  expect((await files("cloudflare-d1"))["generated.ts"]).not.toContain("readonly transaction");
});


test("ctx.store.batch joins the caller transaction and a caught failure still rolls it back", async () => {
  const generated = await files("bun-sqlite");
  const app = await loadGenerated(generated["generated.ts"]!);
  const db = new Database(":memory:");
  let failure: unknown;
  try {
    db.exec(generated["schema.sql"]!);
    const handlers = { "app-note": async ({ store, transaction }: any, input: { title: string }) => {
      const write = async ({ store }: any) => {
        const notes = store.collection("notes");
        const [row] = await store.batch([
          notes.insert(input),
          input.title.startsWith("fail") ? notes.update("missing", input, { lock: 1 }) : notes.insert({ title: input.title + " second" }),
        ]);
        return { title: row.title };
      };
      return input.title.endsWith("joined") ? transaction(write) : write({ store });
    } };
    const data = app.store(db, caller, { handlers });
    const titles = () => db.query("SELECT title FROM notes ORDER BY title").all().map((r: any) => r.title);
    await expect(data.procedures["app-note"]({ title: "fail standalone" })).rejects.toMatchObject({ code: "CONFLICT" });
    expect(titles()).toEqual([]);
    expect(await data.procedures["app-note"]({ title: "ok standalone" })).toEqual({ title: "ok standalone" });
    const before = titles();
    for (const title of ["fail outer", "fail joined"]) {
      const result = await data.transaction(async (tx: any) => {
        await tx.collection("notes").insert({ title: "outer write" });
        try { await tx.procedures["app-note"]({ title }); } catch (error) { failure = error; }
        // A successful batch after the failure does not clear rollback-only state.
        await tx.batch([tx.collection("notes").insert({ title: "after caught failure" })]);
      }).catch((error: unknown) => error);
      expect(failure).toMatchObject({ code: "CONFLICT" });
      expect(result).toBe(failure);
      expect(titles()).toEqual(before);
    }
    await data.transaction(async (tx: any) => {
      expect(await tx.procedures["app-note"]({ title: "ok joined" })).toEqual({ title: "ok joined" });
    });
    expect(titles()).toEqual([...before, "ok joined", "ok joined second"].sort());
  } finally { db.close(); }
});

test("a caught batch rejection with undefined still rejects and rolls back its outer transaction", async () => {
  const generated = await files("bun-sqlite"), app = await loadGenerated(generated["generated.ts"]!);
  const db = new Database(":memory:");
  try {
    db.exec(generated["schema.sql"]!);
    // Fault only this fixture's native execution, retaining a real SQLite transaction underneath.
    const handle = { exec: db.exec.bind(db), transaction: db.transaction.bind(db), query(sql: string) {
      const statement = db.query(sql);
      return { columnNames: statement.columnNames, run: statement.run.bind(statement), all(...values: any[]) {
        if (values.includes("throw undefined")) throw undefined;
        return statement.all(...values);
      } };
    } };
    const data = app.store(handle, caller, { handlers: {} });
    let caught = false;
    const outcome = await data.transaction(async (tx: any) => {
      const notes = tx.collection("notes");
      await notes.insert({ title: "before" });
      await tx.batch([notes.insert({ title: "throw undefined" })]).catch((error: unknown) => { caught = true; expect(error).toBeUndefined(); });
      await tx.batch([notes.insert({ title: "after" })]);
    }).then(() => ({ resolved: true }), (error: unknown) => ({ rejected: true, error }));
    expect(caught).toBe(true);
    expect(outcome).toEqual({ rejected: true, error: undefined });
    expect(db.query("SELECT * FROM notes").all()).toEqual([]);
  } finally { db.close(); }
});
