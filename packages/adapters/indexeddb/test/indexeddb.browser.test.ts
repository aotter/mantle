import {
  linkManifestSet,
  parseManifestSources,
} from "@aotter/mantle-spec";
import {
  EntryStatusConflict,
  EntryUniqueConflict,
  EntryVersionConflict,
  bootMantleRuntime,
  compileRuntimePlan,
  type MantleRuntime,
  type RuntimePlan,
} from "@aotter/mantle-runtime";
import { openDB } from "idb";
import { describe, expect, it } from "vitest";
import { IndexedDbMantleStorageAdapter } from "../src/index.js";

const anonymous = { user: null, staff: null, env: {} } as const;

describe("IndexedDbMantleStorageAdapter in Chrome", () => {
  it("boots Mantle, executes a View and MCP Trigger, and survives reload", async () => {
    const name = databaseName("runtime");
    const storage = new IndexedDbMantleStorageAdapter({ databaseName: name });
    let id = 0;
    const runtime = await boot(storage, {
      clock: { now: () => 1_000 + id },
      idgen: { next: () => `post-${++id}` },
    });
    await runtime.createDraft.execute({
      collection: "posts",
      data: { slug: "tea", title: "Tea", score: 8, locale: "en" },
      authorId: null,
    });
    await runtime.createDraft.execute({
      collection: "posts",
      data: { slug: "cake", title: "Cake", score: 5, locale: "en" },
      authorId: null,
    });
    await runtime.createDraft.execute({
      collection: "posts",
      data: { slug: "cha", title: "茶", score: 9, locale: "zh-TW" },
      authorId: null,
    });

    await expect(runtime.executeView<{ id: string; title: string }>({
      view: "ranked-posts",
      options: { params: { locale: "en" }, show: 1 },
      ctx: anonymous,
    })).resolves.toMatchObject({
      ok: true,
      result: {
        rows: [{ id: "post-1", title: "Tea" }],
        page: 1,
        show: 1,
        hasMore: true,
      },
    });
    await expect(runtime.executeView<{ title: string }>({
      view: "ranked-posts",
      options: {
        params: { locale: "en" },
        search: { term: "cake", fields: ["title"] },
        filters: [{ field: "locale", value: "en" }],
      },
      ctx: anonymous,
    })).resolves.toMatchObject({
      ok: true,
      result: { rows: [{ title: "Cake" }] },
    });
    await expect(runtime.invokeTrigger<{ echoed: string }>({
      trigger: "echo-mcp",
      input: { message: "hello" },
      ctx: anonymous,
    })).resolves.toEqual({ ok: true, data: { echoed: "hello" } });

    const reloaded = await boot(
      new IndexedDbMantleStorageAdapter({ databaseName: name }),
    );
    await expect(reloaded.entries.readBySlug({
      collection: "posts",
      slug: "tea",
      locale: "en",
      status: "published",
    })).resolves.toMatchObject({ id: "post-1", data: { title: "Tea" } });
    await storage.deleteDatabase();
  });

  it("isolates databases and deletes only the selected local world", async () => {
    const first = new IndexedDbMantleStorageAdapter({ databaseName: databaseName("first") });
    const second = new IndexedDbMantleStorageAdapter({ databaseName: databaseName("second") });
    const [a, b] = await Promise.all([first.prepare(plan()), second.prepare(plan())]);
    await Promise.all([
      a.entries.create(entry("same", "first")),
      b.entries.create(entry("same", "second")),
    ]);

    await first.deleteDatabase();
    expect(await b.entries.get("same")).toMatchObject({ data: { title: "second" } });
    const reopened = await first.prepare(plan());
    expect(await reopened.entries.get("same")).toBeNull();
    await Promise.all([first.deleteDatabase(), second.deleteDatabase()]);
  });

  it("keeps OCC and status guards atomic and surfaces storage failures", async () => {
    const storage = new IndexedDbMantleStorageAdapter({ databaseName: databaseName("occ") });
    const { entries } = await storage.prepare(plan());
    await entries.create(entry("post", "original"));

    const updates = await Promise.allSettled([
      entries.update({
        id: "post",
        collection: "posts",
        expectedVersion: 1,
        data: { title: "first" },
        now: 2,
      }),
      entries.update({
        id: "post",
        collection: "posts",
        expectedVersion: 1,
        data: { title: "second" },
        now: 3,
      }),
    ]);
    expect(updates.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(updates.filter(({ status }) => status === "rejected")[0]).toMatchObject({
      reason: expect.any(EntryVersionConflict),
    });
    const committed = await entries.get("post");
    expect(committed).toMatchObject({ version: 2, status: "draft" });

    await expect(entries.transitionStatus({
      id: "post",
      collection: "posts",
      to: "archived",
      expectedStatus: "published",
      expectedVersion: 2,
      now: 4,
    })).rejects.toBeInstanceOf(EntryStatusConflict);
    expect(await entries.get("post")).toEqual(committed);

    await expect(entries.create({
      ...entry("uncloneable", "bad"),
      data: { callback: (() => undefined) as unknown },
    })).rejects.toMatchObject({ name: "DataCloneError" });
    expect(await entries.get("uncloneable")).toBeNull();

    const mutable = { title: "stored" };
    await entries.create({ ...entry("clone", "stored"), data: mutable });
    mutable.title = "mutated after commit";
    expect(await entries.get("clone")).toMatchObject({ data: { title: "stored" } });
    await storage.deleteDatabase();
  });

  it("enforces Schema uniqueIndexes atomically and preserves NULL semantics for optional fields", async () => {
    const storage = new IndexedDbMantleStorageAdapter({ databaseName: databaseName("unique") });
    const { entries } = await storage.prepare(plan(settingsManifest));

    // Two rows omitting the optional unique field 'code' can both be created
    await entries.create({
      id: "entry-1",
      collection: "site-settings",
      status: "draft",
      data: { siteKey: "main", theme: "dark" },
      authorId: null,
      now: 1,
    });
    await entries.create({
      id: "entry-2",
      collection: "site-settings",
      status: "draft",
      data: { siteKey: "secondary", theme: "light" },
      authorId: null,
      now: 2,
    });

    // Row with explicit null optional unique field 'code' can also be created
    await entries.create({
      id: "entry-3",
      collection: "site-settings",
      status: "draft",
      data: { siteKey: "third", code: null, theme: "blue" },
      authorId: null,
      now: 3,
    });

    // Complete duplicate tuple on siteKey: "main" throws EntryUniqueConflict
    await expect(
      entries.create({
        id: "entry-4",
        collection: "site-settings",
        status: "draft",
        data: { siteKey: "main", theme: "solarized" },
        authorId: null,
        now: 4,
      }),
    ).rejects.toBeInstanceOf(EntryUniqueConflict);

    // Row with explicit code: "PROMO" can be created
    await entries.create({
      id: "entry-5",
      collection: "site-settings",
      status: "draft",
      data: { siteKey: "fourth", code: "PROMO", theme: "red" },
      authorId: null,
      now: 5,
    });

    // Duplicate on code: "PROMO" throws EntryUniqueConflict
    await expect(
      entries.create({
        id: "entry-6",
        collection: "site-settings",
        status: "draft",
        data: { siteKey: "fifth", code: "PROMO", theme: "green" },
        authorId: null,
        now: 6,
      }),
    ).rejects.toBeInstanceOf(EntryUniqueConflict);

    await storage.deleteDatabase();
  });

  it("keeps list cursors deterministic in both directions", async () => {
    const storage = new IndexedDbMantleStorageAdapter({ databaseName: databaseName("cursor") });
    const { entries } = await storage.prepare(plan());
    await Promise.all([
      entries.create({ ...entry("a", "Alpha"), now: 1 }),
      entries.create({ ...entry("b", "Beta"), now: 2 }),
      entries.create({ ...entry("c", "Gamma"), now: 3 }),
    ]);

    const first = await entries.list({ collection: "posts", limit: 2 });
    expect(first.rows.map(({ id }) => id)).toEqual(["c", "b"]);
    expect(first.nextCursor).toBeDefined();
    const second = await entries.list({
      collection: "posts",
      limit: 2,
      cursor: first.nextCursor,
    });
    expect(second.rows.map(({ id }) => id)).toEqual(["a"]);
    expect(second.previousCursor).toBeDefined();
    const backward = await entries.list({
      collection: "posts",
      limit: 2,
      cursor: second.previousCursor,
      cursorDirection: "backward",
    });
    expect(backward.rows.map(({ id }) => id)).toEqual(["c", "b"]);
    expect((await entries.list({
      collection: "posts",
      search: "alp",
      searchFields: ["title"],
    })).rows.map(({ id }) => id)).toEqual(["a"]);
    await storage.deleteDatabase();
  });

  it("upgrades non-destructively, unblocks deletion, and reopens", async () => {
    const name = databaseName("upgrade");
    const legacy = await openDB(name, 1, {
      upgrade(database) {
        database.createObjectStore("entries", { keyPath: "id" });
      },
    });
    await legacy.put("entries", entry("legacy", "preserved"));
    let upgraded = false;
    legacy.addEventListener("versionchange", () => {
      upgraded = true;
      setTimeout(() => legacy.close(), 0);
    });

    const storage = new IndexedDbMantleStorageAdapter({ databaseName: name });
    const prepared = await storage.prepare(plan());
    expect(upgraded).toBe(true);
    expect(await prepared.entries.get("legacy")).toMatchObject({ data: { title: "preserved" } });

    const blocker = await openDB(name, 2);
    let deleteVersionChange = false;
    blocker.addEventListener("versionchange", () => {
      deleteVersionChange = true;
      setTimeout(() => blocker.close(), 0);
    });
    await storage.deleteDatabase();
    expect(deleteVersionChange).toBe(true);
    expect(await (await storage.prepare(plan())).entries.get("legacy")).toBeNull();
    await storage.deleteDatabase();
  });

  it("rejects native SQL before creating browser storage", async () => {
    const name = databaseName("native");
    const storage = new IndexedDbMantleStorageAdapter({ databaseName: name });
    await expect(storage.prepare(plan(nativeView))).rejects.toMatchObject({
      diagnostic: { code: "VIEW_DIALECT_UNSUPPORTED" },
    });
    expect((await indexedDB.databases()).some((database) => database.name === name)).toBe(false);
  });

  it("records the O(n) declarative View scan baseline", async () => {
    const storage = new IndexedDbMantleStorageAdapter({ databaseName: databaseName("baseline") });
    const prepared = await storage.prepare(plan());
    await Promise.all(Array.from({ length: 250 }, (_, index) => prepared.entries.create({
      ...entry(`post-${index.toString().padStart(3, "0")}`, `Post ${index}`),
      status: "published",
      data: {
        slug: `post-${index}`,
        title: `Post ${index}`,
        score: index,
        locale: "en",
      },
      now: index,
    })));
    const started = performance.now();
    const result = await prepared.views.execute({
      view: "ranked-posts",
      params: { locale: "en" },
      show: 50,
    });
    const elapsed = performance.now() - started;

    expect(result.rows).toHaveLength(50);
    expect(Number.isFinite(elapsed)).toBe(true);
    console.info(`indexeddb O(n) scan baseline: 250 rows in ${elapsed.toFixed(2)}ms`);
    await storage.deleteDatabase();
  });
});

function entry(id: string, title: string) {
  return {
    id,
    collection: "posts",
    status: "draft" as const,
    data: { title },
    authorId: null,
    now: 1,
  };
}

async function boot(
  storage: IndexedDbMantleStorageAdapter,
  ports: Parameters<typeof bootMantleRuntime>[0]["ports"] = {},
): Promise<MantleRuntime> {
  return bootMantleRuntime({
    plan: plan(),
    storage,
    handlers: {
      echo: (input) => ({ echoed: (input as { message: string }).message }),
    },
    ports,
  });
}

function plan(extra = ""): RuntimePlan {
  const parsed = parseManifestSources({
    sources: [{ sourceId: "memory:indexeddb", text: `${manifests}\n${extra}` }],
  });
  if (!parsed.ok) throw new Error(parsed.diagnostics.map(({ message }) => message).join("\n"));
  const linked = linkManifestSet(parsed.value);
  if (!linked.ok) throw new Error(linked.diagnostics.map(({ message }) => message).join("\n"));
  const compiled = compileRuntimePlan(linked.value);
  if (!compiled.ok) throw new Error(compiled.diagnostics.map(({ message }) => message).join("\n"));
  return compiled.value;
}

function databaseName(label: string): string {
  return `mantle-indexeddb-test-${label}-${crypto.randomUUID()}`;
}

const manifests = `apiVersion: cms.mantle.aotter.net/v1
kind: Schema
metadata: { name: posts }
spec:
  title: Posts
  lifecycle: operational
  localized: true
  schema:
    type: object
    required: [slug, title, score, locale]
    properties:
      slug: { type: string }
      title: { type: string }
      score: { type: number }
      locale: { type: string }
---
apiVersion: cms.mantle.aotter.net/v1
kind: View
metadata: { name: ranked-posts }
spec:
  surface: public
  from: posts
  fields: [id, title, score, locale]
  params:
    type: object
    required: [locale]
    properties:
      locale: { type: string }
  filter:
    and:
      - { eq: { field: status, value: published } }
      - { eq: { field: locale, value: { $param: locale } } }
      - { gt: { field: score, value: 0 } }
  orderBy: [{ field: score, direction: desc }]
  limit: 50
---
apiVersion: cms.mantle.aotter.net/v1
kind: Procedure
metadata: { name: echo }
spec:
  input:
    type: object
    required: [message]
    properties: { message: { type: string } }
  output:
    type: object
    required: [echoed]
    properties: { echoed: { type: string } }
  handler: { kind: ref, ref: echo }
---
apiVersion: cms.mantle.aotter.net/v1
kind: Trigger
metadata: { name: echo-mcp }
spec:
  source: { kind: mcp, surface: public }
  target: { procedure: echo }
`;

const nativeView = `---
apiVersion: cms.mantle.aotter.net/v1
kind: View
metadata: { name: native-posts }
spec:
  surface: public
  sql: SELECT * FROM entries
`;

const settingsManifest = `---
apiVersion: cms.mantle.aotter.net/v1
kind: Schema
metadata: { name: site-settings }
spec:
  title: Site Settings
  lifecycle: operational
  schema:
    type: object
    required: [siteKey, theme]
    properties:
      siteKey: { type: string }
      code: { type: string }
      theme: { type: string }
  uniqueIndexes: [[siteKey], [code]]
`;
