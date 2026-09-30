import { afterAll, beforeAll, expect, it } from "vitest";
import { LocalD1 } from "../../src/cloudflare/testing/d1.js";
import { compilePlan, DiagnosticError } from "../../src/spec/index.js";
import { createMantleRuntime, type Caller, type HandlerContext, type MantleHandlers, type MantleRuntime } from "../../src/core/index.js";
import { sqliteStorage } from "../../src/core/sql/adapter.js";

const MANIFESTS = `apiVersion: cms.mantle.aotter.net/v2
kind: Schema
metadata: { name: articles }
spec:
  title: Articles
  lifecycle: publishing
  schema:
    type: object
    required: [title, body]
    properties: { title: { type: string, minLength: 3 }, body: { type: string } }
---
apiVersion: cms.mantle.aotter.net/v2
kind: Schema
metadata: { name: pages }
spec:
  title: Pages
  lifecycle: publishing
  schema:
    type: object
    required: [slug, headline]
    properties: { slug: { type: string }, headline: { type: string } }
---
apiVersion: cms.mantle.aotter.net/v2
kind: Schema
metadata: { name: page-translations }
spec:
  title: Page translations
  lifecycle: publishing
  localized: true
  translates: { parent: pages, on: slug }
  schema:
    type: object
    required: [slug, locale, headline]
    properties: { slug: { type: string }, locale: { type: string }, headline: { type: string } }
---
apiVersion: cms.mantle.aotter.net/v2
kind: Procedure
metadata: { name: edit-article }
spec:
  requires: { auth: { all: [ctx.user] } }
  input: { type: object, required: [id, title], properties: { id: { type: string }, title: { type: string } } }
  output: { type: object }
  handler: { sql: "UPDATE articles SET title = input.title WHERE id = input.id RETURNING id" }
---
apiVersion: cms.mantle.aotter.net/v2
kind: Procedure
metadata: { name: edit-reversed }
spec:
  requires: { auth: { all: [ctx.user] } }
  input: { type: object, required: [id, title], properties: { id: { type: string }, title: { type: string } } }
  output: { type: object }
  handler: { sql: "UPDATE articles SET title = input.title WHERE input.id = id RETURNING id" }
---
apiVersion: cms.mantle.aotter.net/v2
kind: Procedure
metadata: { name: gate }
spec: { input: { type: object }, output: { type: object }, handler: { ref: gate } }
---
apiVersion: cms.mantle.aotter.net/v2
kind: Procedure
metadata: { name: log }
spec: { input: { type: object }, output: { type: object }, handler: { ref: log } }
---
apiVersion: cms.mantle.aotter.net/v2
kind: Trigger
metadata: { name: gate-publish }
spec: { source: { kind: lifecycle, schema: articles, on: [before_publish] }, target: { procedure: gate } }
---
apiVersion: cms.mantle.aotter.net/v2
kind: Trigger
metadata: { name: log-after }
spec: { source: { kind: lifecycle, schema: articles, on: [after_publish, after_update] }, target: { procedure: log } }
---
apiVersion: cms.mantle.aotter.net/v2
kind: View
metadata: { name: live }
spec: { surface: public, sql: "SELECT id, title FROM articles ORDER BY title" }
`;
const user: Caller = { kind: "user", subject: "editor", role: null, scopes: [], credential: "session", credentialId: null, clientId: null };
const seen: { hook: string; rows: unknown[] }[] = [];
const handlers = {
  gate: (_i: unknown, ctx: HandlerContext) => {
    if (ctx.cause.kind === "lifecycle") seen.push({ hook: ctx.cause.hook, rows: [...ctx.cause.rows] });
    if (ctx.cause.kind === "lifecycle" && ctx.cause.rows[0]?.title === "veto") throw new DiagnosticError({ code: "LIFECYCLE_HOOK_REJECTED", phase: "runtime", severity: "error", path: "gate", message: "vetoed", value: undefined, expected: undefined, candidates: undefined, suggestion: undefined });
    return {};
  },
  log: (_i: unknown, ctx: HandlerContext) => { if (ctx.cause.kind === "lifecycle") seen.push({ hook: ctx.cause.hook, rows: [...ctx.cause.rows] }); return {}; },
} as unknown as MantleHandlers<never>;

let rt: MantleRuntime;
let d1: LocalD1;
beforeAll(async () => {
  const res = await compilePlan({ sources: [{ sourceId: "memory:life", text: MANIFESTS }] });
  if (!res.ok) throw new Error(JSON.stringify(res.diagnostics));
  d1 = await LocalD1.create();
  rt = await createMantleRuntime({ plan: res.plan, handlers, storage: sqliteStorage(d1) });
}, 60_000);
afterAll(() => d1.dispose());

const store = () => rt.store.as(user);
const failure = async (p: Promise<unknown>) => (await p.then(() => undefined, (e) => e)) as DiagnosticError | undefined;
const status = async (id: string) => (await store().select({ from: "articles", columns: ["status"], where: { id } })).rows[0]?.status;
const draft = async (values: Record<string, unknown>) => ((await store().write([{ insert: "articles", values }]))[0] as { id: string }).id;

it("an insert is a draft that may be incomplete; a publish must leave a complete entry, and fails without changing anything", async () => {
  const id = await draft({ title: "hello" });
  expect(await status(id)).toBe("draft");
  expect((await failure(store().write([{ update: "articles", set: { status: "published" }, where: { id } }])))?.diagnostic).toMatchObject({ code: "INPUT_VALIDATION_FAILED", message: expect.stringContaining("body") });
  expect(await status(id)).toBe("draft");
  await store().write([{ update: "articles", set: { body: "text" }, where: { id } }]);
  const [pub] = await store().write([{ update: "articles", set: { status: "published" }, where: { id } }]);
  expect(pub).toMatchObject({ id, version: 3 });
  expect(await status(id)).toBe("published");
});

it("only a draft can be edited and a published entry cannot be deleted, on the Store and on an inline program alike; unpublish reopens it", async () => {
  const id = await draft({ title: "stable", body: "b" });
  await store().write([{ update: "articles", set: { status: "published" }, where: { id } }]);
  const attempts = [
    () => store().write([{ update: "articles", set: { title: "changed" }, where: { id } }]),
    () => rt.invokeProcedure({ procedure: "edit-article", input: { id, title: "changed" }, caller: user, cause: { kind: "http", id: "e" } }),
    () => store().write([{ delete: "articles", where: { id } }]),
  ];
  for (const a of attempts) expect((await failure(a()))?.diagnostic).toMatchObject({ code: "CONFLICT", message: expect.stringMatching(/published|draft/) });
  await store().write([{ update: "articles", set: { status: "draft" }, where: { id } }]);
  await store().write([{ update: "articles", set: { title: "reopened" }, where: { id } }]);
  await store().write([{ update: "articles", set: { status: "archived" }, where: { id } }]);
  expect((await failure(store().write([{ update: "articles", set: { status: "published" }, where: { id } }])))?.diagnostic.message).toMatch(/status change is not allowed/);
  expect(await status(id)).toBe("archived");
});

it("a publish fires the publish hooks, not the update hooks; a before hook can veto it", async () => {
  seen.length = 0;
  const id = await draft({ title: "hooked", body: "b" });
  await store().write([{ update: "articles", set: { status: "published" }, where: { id } }]);
  expect(seen.map((s) => s.hook)).toEqual(["before_publish", "after_publish"]);
  expect(seen[0]!.rows[0]).toMatchObject({ id, status: "draft", title: "hooked" });
  expect(seen[1]!.rows[0]).toMatchObject({ id, version: 2 });
  const vetoed = await draft({ title: "veto", body: "b" });
  expect((await failure(store().write([{ update: "articles", set: { status: "published" }, where: { id: vetoed } }])))?.diagnostic.code).toBe("LIFECYCLE_HOOK_REJECTED");
  expect(await status(vetoed)).toBe("draft");
});

it("a public View shows published entries only", async () => {
  const live = (await rt.store.as({ kind: "anonymous" }).view("live")).rows.map((r) => r.title);
  expect(live).toContain("hooked");
  expect(live).toContain("hello");
  expect(live).not.toContain("veto");
  expect(live).not.toContain("reopened");
});

it("an input named id is a value, not the target: a reversed comparison edits the entry it names, and the lifecycle decides on that entry", async () => {
  const published = await draft({ title: "live", body: "b" });
  await store().write([{ update: "articles", set: { status: "published" }, where: { id: published } }]);
  const other = await draft({ title: "wip", body: "b" });
  const edit = (id: string) => rt.invokeProcedure({ procedure: "edit-reversed", input: { id, title: "HACKED" }, caller: user, cause: { kind: "http", id: "r" } });
  expect((await failure(edit(published)))?.diagnostic.code).toBe("CONFLICT");
  expect((await store().select({ from: "articles", columns: ["title"], where: { id: published } })).rows).toEqual([{ title: "live" }]);
  await edit(other);
  expect((await store().select({ from: "articles", columns: ["title"], where: { id: other } })).rows).toEqual([{ title: "HACKED" }]);
});

it("a status change carries no other values, so no edit can hide inside a publish", async () => {
  const id = await draft({ title: "bundle", body: "b" });
  expect((await failure(store().write([{ update: "articles", set: { status: "published", title: "changed" }, where: { id } }])))?.diagnostic.message).toMatch(/status change carries no other values/);
  expect(await status(id)).toBe("draft");
});

it("a translation publishes only after its parent (translates)", async () => {
  const w = async (from: string, values: Record<string, unknown>) => ((await store().write([{ insert: from, values }]))[0] as { id: string }).id;
  const publish = (from: string, id: string) => store().write([{ update: from, set: { status: "published" }, where: { id } }]);
  const tr = await w("page-translations", { slug: "about", locale: "zh-TW", headline: "關於" });
  const orphan = await failure(publish("page-translations", tr));
  expect(orphan?.diagnostic).toMatchObject({ code: "CONFLICT", message: expect.stringContaining("publish the pages entry with the same slug first") });
  const parent = await w("pages", { slug: "about", headline: "About" });
  expect((await failure(publish("page-translations", tr)))?.diagnostic.code).toBe("CONFLICT"); // the parent is still a draft
  await publish("pages", parent);
  await publish("page-translations", tr);
  expect((await store().select({ from: "page-translations", columns: ["status"], where: { id: tr } })).rows).toEqual([{ status: "published" }]);
});
