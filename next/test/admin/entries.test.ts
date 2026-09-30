import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LocalD1 } from "../../src/cloudflare/testing/d1.js";
import { compilePlan, type StaffRole } from "../../src/spec/index.js";
import { createMantleRuntime, type Caller, type MantleRuntime } from "../../src/core/index.js";
import { sqliteStorage } from "../../src/d1/index.js";
import { createAdminSurface } from "../../src/admin/index.js";

const MANIFESTS = `apiVersion: cms.mantle.aotter.net/v2
kind: Schema
metadata: { name: articles }
spec:
  title: Articles
  lifecycle: publishing
  searchableFields: [title, body]
  schema:
    type: object
    required: [slug, title, body]
    properties: { slug: { type: string }, title: { type: string }, body: { type: string }, rank: { type: integer } }
---
apiVersion: cms.mantle.aotter.net/v2
kind: Schema
metadata: { name: article-translations }
spec:
  title: Article translations
  lifecycle: publishing
  localized: true
  translates: { parent: articles, on: slug }
  schema:
    type: object
    required: [slug, locale, title]
    properties: { slug: { type: string }, locale: { type: string }, title: { type: string } }
---
apiVersion: cms.mantle.aotter.net/v2
kind: Schema
metadata: { name: metrics }
spec:
  title: Metrics
  lifecycle: operational
  uiSchema: { list: { primaryField: name, columns: [value] } }
  schema:
    type: object
    required: [name, value]
    properties: { name: { type: string }, value: { type: integer }, note: { type: string } }
---
apiVersion: cms.mantle.aotter.net/v2
kind: Schema
metadata: { name: notes }
spec:
  title: Notes
  lifecycle: operational
  scope: { owner: auth.uid() }
  indexes: [[owner]]
  schema:
    type: object
    required: [owner, text]
    properties: { owner: { type: string }, text: { type: string } }
---
apiVersion: cms.mantle.aotter.net/v2
kind: Schema
metadata: { name: ledger }
spec:
  title: Ledger
  lifecycle: operational
  schema: { type: object, readOnly: true, required: [amount], properties: { amount: { type: integer } } }
---
apiVersion: cms.mantle.aotter.net/v2
kind: View
metadata: { name: metric-list }
spec: { surface: staff, uiSchema: { list: { columns: [name, note] } }, sql: "SELECT id, name, note FROM metrics ORDER BY name" }
---
apiVersion: cms.mantle.aotter.net/v2
kind: View
metadata: { name: metric-hidden }
spec: { surface: internal, sql: "SELECT id FROM metrics ORDER BY id" }
`;

const staff = (subject: string, role: StaffRole | null): Caller => ({ kind: "user", subject, role, scopes: [], credential: "session", credentialId: null, clientId: null });
const owner = staff("u-owner", "owner");
const editor = staff("u-editor", "editor");
const contributor = staff("u-contrib", "contributor");

let rt: MantleRuntime;
let d1: LocalD1;
beforeAll(async () => {
  const res = await compilePlan({ sources: [{ sourceId: "memory:entries", text: MANIFESTS }] });
  if (!res.ok) throw new Error(JSON.stringify(res.diagnostics));
  d1 = await LocalD1.create();
  rt = await createMantleRuntime({ plan: res.plan, handlers: {}, storage: sqliteStorage(d1) });
}, 60_000);
afterAll(() => d1.dispose());

const call = async (method: string, path: string, caller: Caller, body?: unknown) => {
  const res = await createAdminSurface(rt, { basePath: "/admin" })(new Request(`http://x${path}`, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), caller);
  const text = await res.text();
  let json: any;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json, headers: res.headers };
};
const create = async (collection: string, data: Record<string, unknown>, caller: Caller = editor) => {
  const r = await call("POST", "/admin/api/entries", caller, { collection, data });
  expect(r.status).toBe(200);
  return r.body.entry as { id: string; version: number; status: string };
};
const at = (id: string, collection: string, suffix = "") => `/admin/api/entries/${id}${suffix}?collection=${collection}`;

describe("Admin entries: role rules", () => {
  it("a contributor creates and edits drafts of a publishing Schema, and nothing else", async () => {
    const draft = await create("articles", { slug: "c1", title: "Draft", body: "b" }, contributor);
    expect(draft.status).toBe("draft");
    expect((await call("PATCH", at(draft.id, "articles"), contributor, { data: { title: "Draft 2" }, expectedVersion: draft.version })).status).toBe(200);
    // an operational Schema is not the contributor's, to create or to edit
    const denied = await call("POST", "/admin/api/entries", contributor, { collection: "metrics", data: { name: "m", value: 1 } });
    expect(denied).toMatchObject({ status: 403, body: { error: { code: "AUTH_DENIED" }, minimumRole: "editor" } });
    const metric = await create("metrics", { name: "m", value: 1 });
    expect((await call("PATCH", at(metric.id, "metrics"), contributor, { data: { value: 2 }, expectedVersion: metric.version })).status).toBe(403);
    // publish, unpublish and delete are the editor's
    for (const [method, suffix] of [["POST", "/publish"], ["POST", "/unpublish"], ["DELETE", ""]] as const) {
      expect((await call(method, at(draft.id, "articles", suffix), contributor)).body.minimumRole).toBe("editor");
    }
    // `data` cannot carry a status past the publish gate
    expect((await call("PATCH", at(draft.id, "articles"), contributor, { data: { status: "published" }, expectedVersion: 1 })).status).toBe(400);
    expect((await call("POST", "/admin/api/entries", contributor, { collection: "articles", data: { slug: "c2", status: "published" } })).status).toBe(400);
    // once published, the entry is no longer the contributor's to edit
    const current = (await call("GET", at(draft.id, "articles"), contributor)).body.entry;
    expect((await call("POST", at(draft.id, "articles", "/publish"), editor)).body.entry.status).toBe("published");
    expect((await call("PATCH", at(draft.id, "articles"), contributor, { data: { title: "x" }, expectedVersion: current.version + 1 })).body.minimumRole).toBe("editor");
  });

  it("an editor publishes, unpublishes and deletes; Store's lifecycle still holds", async () => {
    const a = await create("articles", { slug: "e1", title: "Edit me", body: "b" });
    expect((await call("POST", at(a.id, "articles", "/publish"), editor)).body.entry.status).toBe("published");
    expect((await call("DELETE", at(a.id, "articles"), editor)).body.error.code).toBe("CONFLICT"); // a published entry is not deleted
    expect((await call("POST", at(a.id, "articles", "/unpublish"), editor)).body.entry.status).toBe("draft");
    const removed = await call("DELETE", at(a.id, "articles"), editor);
    expect(removed.body).toEqual({ id: a.id, version: expect.any(Number) });
    expect((await call("GET", at(a.id, "articles"), editor)).status).toBe(404);
  });

  it("a root readOnly Schema is CONFLICT to every generic write, and still reads", async () => {
    await rt.store.write([{ insert: "ledger", values: { amount: 5 } }]);
    expect((await call("POST", "/admin/api/entries", owner, { collection: "ledger", data: { amount: 1 } })).body.error.code).toBe("CONFLICT");
    const { items } = (await call("GET", "/admin/api/entries?collection=ledger", owner)).body;
    expect(items).toHaveLength(1);
    expect((await call("PATCH", at(items[0].id, "ledger"), owner, { data: { amount: 2 }, expectedVersion: items[0].version })).status).toBe(409);
    expect((await call("DELETE", at(items[0].id, "ledger"), owner)).status).toBe(409);
  });

  it("an unknown collection is 404 and a missing one 400", async () => {
    expect((await call("GET", "/admin/api/entries?collection=nope", editor)).status).toBe(404);
    expect((await call("GET", "/admin/api/entries?collection=constructor", editor)).status).toBe(404);
    expect((await call("GET", at("x", "nope"), editor)).status).toBe(404);
    expect((await call("POST", "/admin/api/entries", editor, { collection: "nope", data: {} })).status).toBe(404);
    expect((await call("GET", "/admin/api/entries/export?collection=nope", editor)).status).toBe(404);
    expect((await call("GET", "/admin/api/entries", editor)).status).toBe(400);
  });
});

describe("Admin entries: writes through Store", () => {
  it("a stale expectedVersion is 409 with conflict.reason lock, on a publishing and an operational Schema", async () => {
    for (const [collection, data] of [["articles", { slug: "l1", title: "Lock", body: "b" }], ["metrics", { name: "lock", value: 1 }]] as const) {
      const e = await create(collection, data);
      const ok = await call("PATCH", at(e.id, collection), editor, { data: collection === "articles" ? { title: "v2" } : { value: 2 }, expectedVersion: e.version });
      expect(ok.body.entry.version).toBe(e.version + 1);
      const stale = await call("PATCH", at(e.id, collection), editor, { data: collection === "articles" ? { title: "v3" } : { value: 3 }, expectedVersion: e.version });
      expect([collection, stale.status, stale.body.error.code, stale.body.error.conflict?.reason]).toEqual([collection, 409, "CONFLICT", "lock"]);
    }
    expect((await call("PATCH", at("x", "metrics"), editor, { data: { value: 1 } })).status).toBe(404);
  });

  it("a publish needs a complete entry", async () => {
    const e = await create("articles", { slug: "p1", title: "No body" });
    const r = await call("POST", at(e.id, "articles", "/publish"), editor);
    expect([r.status, r.body.error.code]).toEqual([400, "INPUT_VALIDATION_FAILED"]);
  });

  it("a translation publishes only after its parent, as a 409 that says so", async () => {
    const parent = await create("articles", { slug: "t1", title: "Parent", body: "b" });
    const fr = await create("article-translations", { slug: "t1", locale: "fr", title: "Parent FR" });
    const early = await call("POST", at(fr.id, "article-translations", "/publish"), editor);
    expect([early.status, early.body.error.code]).toEqual([409, "CONFLICT"]);
    expect(early.body.error.message).toMatch(/publish the articles entry with the same slug first/);
    await call("POST", at(parent.id, "articles", "/publish"), editor);
    expect((await call("POST", at(fr.id, "article-translations", "/publish"), editor)).body.entry.status).toBe("published");
  });

  it("the editor payload carries the parent and the related translations", async () => {
    const parent = await create("articles", { slug: "r1", title: "Root", body: "b" });
    const de = await create("article-translations", { slug: "r1", locale: "de", title: "Wurzel" });
    const child = (await call("GET", at(de.id, "article-translations"), editor)).body;
    expect(child).toMatchObject({ parentEntryId: parent.id, parentEntryTitle: "Root", entry: { locale: "de", data: { slug: "r1", title: "Wurzel" } }, collection: { parent: { collection: "articles", parentField: "slug" }, localized: true } });
    const root = (await call("GET", at(parent.id, "articles"), editor)).body;
    expect(root.related).toEqual([expect.objectContaining({ relationship: { kind: "translation", parentField: "slug", childField: "slug", parentValue: "r1" }, entries: [expect.objectContaining({ id: de.id, locale: "de" })] })]);
    expect(root.entry.updated_at).toBeLessThan(Date.now() + 1000); // milliseconds on the wire, as before
    expect(root.entry.updated_at).toBeGreaterThan(Date.now() - 60_000);
  });
});

describe("Admin entries: the list", () => {
  it("each row names its translation locales, from a second select over the page's keys", async () => {
    const a = await create("articles", { slug: "loc", title: "Locales", body: "b" });
    await create("articles", { slug: "none", title: "No locales", body: "b" });
    const locales = ["de", "fr", "ja", "es"];
    for (const locale of locales) await create("article-translations", { slug: "loc", locale, title: `in ${locale}` });
    const { items } = (await call("GET", "/admin/api/entries?collection=articles&search=locales", editor)).body;
    expect(items.map((i: any) => [i.id === a.id ? "loc" : "none", [...i.translation_locales].sort()]).sort()).toEqual([["loc", [...locales].sort()], ["none", []]]);
  });

  it("search goes to Store (the searchable fields, or the id); filter and status narrow; the title comes from the entry", async () => {
    const a = await create("articles", { slug: "s1", title: "Haystack", body: "a needle inside", rank: 7 });
    const ids = async (q: string) => (await call("GET", `/admin/api/entries?collection=articles&${q}`, editor)).body.items.map((i: any) => i.id);
    expect(await ids("search=NEEDLE")).toEqual([a.id]);
    expect(await ids(`search=${a.id}`)).toEqual([a.id]);
    expect(await ids("search=s1")).toEqual([]); // slug is not a searchable field
    expect(await ids("filter_field=rank&filter_value=7")).toEqual([a.id]);
    expect(await ids("filter_field=rank&filter_value=7&status=published")).toEqual([]);
    expect((await call("GET", "/admin/api/entries?collection=articles&filter_field=rank", editor)).status).toBe(400);
    expect((await call("GET", "/admin/api/entries?collection=articles&search=needle", editor)).body.items[0]).toMatchObject({ title: "Haystack", status: "draft", locale: null, translation_locales: [] });
  });

  it("pages forward only: next_cursor and no previous cursor; a backward request is 400", async () => {
    const q = "/admin/api/entries?collection=metrics&sort=name&direction=asc&limit=2";
    for (const name of ["page-a", "page-b", "page-c"]) await create("metrics", { name, value: 0 });
    const p1 = (await call("GET", q, editor)).body;
    expect(Object.keys(p1).sort()).toEqual(["items", "next_cursor"]);
    expect(p1.items[0]).toMatchObject({ title: null, data_preview: { name: expect.any(String), value: expect.any(Number) } });
    const p2 = (await call("GET", `${q}&cursor=${encodeURIComponent(p1.next_cursor)}`, editor)).body;
    expect(p2.items.map((i: any) => i.id)).not.toContain(p1.items[0].id);
    expect((await call("GET", `${q}&cursor=${encodeURIComponent(p1.next_cursor)}&cursor_direction=backward`, editor)).status).toBe(400);
  });

  it("translation keys of a long page go in chunks under the bind limit", async () => {
    for (let i = 0; i < 120; i += 20) await rt.store.write(Array.from({ length: 20 }, (_, k) => ({ insert: "articles", values: { slug: `bulk-${i + k}`, title: "Bulk", body: "b" } })));
    await create("article-translations", { slug: "bulk-7", locale: "it", title: "Sette" });
    const r = await call("GET", "/admin/api/entries?collection=articles&search=bulk&limit=120", editor);
    expect(r.status).toBe(200);
    expect(r.body.items).toHaveLength(120);
    expect(r.body.items.filter((i: any) => i.translation_locales.length).map((i: any) => i.translation_locales)).toEqual([["it"]]);
  });

  it("bootstrap carries the first page when a collection is named", async () => {
    const b = (await call("GET", "/admin/api/bootstrap?collection=metrics&limit=1", editor)).body;
    expect(b.entries.items).toHaveLength(1);
    expect(b.entries.next_cursor).toEqual(expect.any(String));
    expect("entries" in (await call("GET", "/admin/api/bootstrap", editor)).body).toBe(false);
  });

  it("G2b default: Admin reads a scoped Schema as the caller, so a staff member sees only their own rows", async () => {
    await create("notes", { text: "owner's" }, owner);
    await create("notes", { text: "editor's" }, editor);
    const seen = async (c: Caller) => (await call("GET", "/admin/api/entries?collection=notes", c)).body.items.map((i: any) => i.data_preview ?? i.id);
    expect(await seen(owner)).toHaveLength(1);
    expect(await seen(editor)).toHaveLength(1);
    const [mine] = (await call("GET", "/admin/api/entries?collection=notes", editor)).body.items;
    expect((await call("GET", at(mine.id, "notes"), owner)).status).toBe(404); // another staff member's row is not there for the owner either
  });
});

describe("Admin entries: names a client chooses", () => {
  it("a prototype name as a filter, scope, sort or data key is a 400, never a 500", async () => {
    for (const q of ["filter_field=constructor&filter_value=x", "filter_field=__proto__&filter_value=x", "scope_field=constructor&scope_value=x", "sort=constructor", "sort=__proto__"])
      expect([q, (await call("GET", `/admin/api/entries?collection=metrics&${q}`, contributor)).status]).toEqual([q, 400]);
    for (const data of [{ constructor: "x" }, JSON.parse('{"__proto__":"x","name":"p"}')]) {
      expect((await call("POST", "/admin/api/entries", editor, { collection: "metrics", data })).status).toBe(400);
    }
  });
});

describe("Admin entries: CSV", () => {
  const rows = (text: string) => text.replace(/^﻿/, "").split("\r\n").filter(Boolean);

  it("a page that fails after the download began ends it as failed, with a trace", async () => {
    const store = rt.store.as(editor);
    let n = 0;
    const flaky = { ...rt, store: { ...rt.store, as: () => ({ ...store, select: async (q: never) => (++n > 1 ? Promise.reject(new Error("D1 limit")) : { ...(await store.select(q)), nextCursor: "more" }) }) } } as unknown as MantleRuntime;
    const log = console.error;
    const seen: unknown[][] = [];
    console.error = (...a: unknown[]) => void seen.push(a);
    try {
      const res = await createAdminSurface(flaky, { basePath: "/admin" })(new Request("http://x/admin/api/entries/export?collection=metrics&limit=1"), editor);
      await expect(res.text()).rejects.toThrow("D1 limit");
    } finally { console.error = log; }
    expect(seen.some((a) => String(a[0]).includes("export failed"))).toBe(true);
  });

  it("exports every page, quotes, and defuses formula prefixes", async () => {
    const tricky = ['say "hi", then\nleave', "=SUM(A1)", "+1", "-2", "@cmd", " \t=x", "\tTAB", "\rCR"];
    for (let i = 0; i < 600; i += 20) await rt.store.write(Array.from({ length: 20 }, (_, k) => i + k).map((n) => ({ insert: "metrics", values: { name: `bulk-${String(n).padStart(3, "0")}`, value: -n, ...(n < tricky.length ? { note: tricky[n] } : {}) } })));
    const r = await call("GET", "/admin/api/entries/export?collection=metrics&filter_field=name&filter_value=", editor);
    expect(r.status).toBe(400); // a bad query is JSON before the download starts
    const res = await createAdminSurface(rt, { basePath: "/admin" })(new Request("http://x/admin/api/entries/export?collection=metrics&sort=name&direction=asc"), editor);
    expect([res.headers.get("content-type"), res.headers.get("content-disposition")]).toEqual(["text/csv; charset=utf-8", 'attachment; filename="metrics.csv"']);
    const text = await res.text();
    const lines = rows(text);
    expect(lines[0]).toBe("id,version,updated_at,name,value,note");
    expect(lines.filter((l) => l.includes(",bulk-"))).toHaveLength(600); // crosses the 500-row export page
    expect(text).toContain(',"say ""hi"", then\nleave"\r\n');
    for (const cell of ["'=SUM(A1)", "'+1", "'-2", "'@cmd", "' \t=x", "'\tTAB"]) expect(text).toContain(`,${cell}\r\n`);
    expect(lines[3]).toMatch(/,-2,'\+1$/); // a negative number is a number, not a formula
  });

  it("exports a staff View with its declared columns, and hides a non-staff View", async () => {
    const res = await createAdminSurface(rt, { basePath: "/admin" })(new Request("http://x/admin/api/views/metric-list/export"), contributor);
    const lines = rows(await res.text());
    expect(lines[0]).toBe("name,note");
    expect(lines.filter((l) => l.startsWith("bulk-"))).toHaveLength(600); // crosses the 500-row View page
    expect((await call("GET", "/admin/api/views/metric-hidden/export", owner)).status).toBe(404);
  });
});
