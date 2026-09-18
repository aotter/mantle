import { linkManifestSet, parseManifestSources } from "@aotter/mantle-spec";
import { EntryStatusConflict, EntryVersionConflict } from "../../domain/model/EntryRow.js";
import type { CreateEntryArgs } from "../../domain/port/EntryRepository.js";
import type { PreparedMantleStorage } from "../../domain/port/MantleStorageAdapter.js";
import { compileRuntimePlan, type RuntimePlan } from "../../domain/service/RuntimePlanCompiler.js";

export interface StorageConformanceFixture {
  readonly storage: PreparedMantleStorage;
  /** Release all resources, including the isolated database, even after failure. */
  readonly cleanup: () => void | Promise<void>;
}

export interface StorageConformanceOptions {
  /**
   * Prepare a fresh, empty store for each check. Never supply a live database.
   * Adapters with a locale policy must enable en, zh-TW and ja for this fixture.
   */
  readonly create: (plan: RuntimePlan) => Promise<StorageConformanceFixture>;
}

export interface StorageConformanceFailure {
  readonly check: string;
  readonly phase: "setup" | "assertion" | "cleanup";
  readonly message: string;
}

export interface StorageConformanceReport {
  readonly ok: boolean;
  /** Stable check identifiers, in execution order, including failed checks. */
  readonly checks: readonly string[];
  readonly failures: readonly StorageConformanceFailure[];
}

/**
 * Check the existing semantic ports using synthetic JSON data and a sealed plan.
 * Cases run sequentially with separate storage. Failures never suppress cleanup
 * or later cases. This is a baseline, not certification of every adapter feature.
 */
export async function runStorageConformance(
  options: StorageConformanceOptions,
): Promise<StorageConformanceReport> {
  const plan = fixturePlan();
  const failures: StorageConformanceFailure[] = [];
  for (const [check, run] of checks) {
    let fixture: StorageConformanceFixture;
    try {
      fixture = await options.create(plan);
    } catch (error) {
      failures.push({ check, phase: "setup", message: errorMessage(error) });
      continue;
    }
    try {
      await run(fixture.storage);
    } catch (error) {
      failures.push({ check, phase: "assertion", message: errorMessage(error) });
    } finally {
      try {
        await fixture.cleanup();
      } catch (error) {
        failures.push({ check, phase: "cleanup", message: errorMessage(error) });
      }
    }
  }
  return { ok: failures.length === 0, checks: checks.map(([id]) => id), failures };
}

const collection = "conformance-posts";
const otherCollection = "conformance-other";
const key = (id: string, target = collection) => ({ id, collection: target });
const checks: readonly (readonly [string, (storage: PreparedMantleStorage) => Promise<void>])[] = [
  ["entries.crud", async ({ entries }) => {
    equal(await entries.get(key("a")), null, "missing get");
    equal(await entries.readById(key("a")), null, "missing readById");
    const args = entry("a");
    const created = await entries.create(args);
    equal(created, {
      id: "a", collection, status: "draft", version: 1, data: args.data,
      authorId: "synthetic-author", createdAt: 100, updatedAt: 100, locale: "en",
    }, "created row");
    equal(await entries.get(key("a")), created, "persisted create");
    const updated = await entries.update({
      id: "a", collection, expectedVersion: 1, data: { title: "Replacement" }, now: 200,
    });
    equal(updated, {
      id: "a", collection, status: "draft", version: 2,
      data: { title: "Replacement", locale: null }, authorId: "synthetic-author",
      createdAt: 100, updatedAt: 200,
    }, "update replaces data and clears lifted locale");
    equal(await entries.get(key("a")), updated, "persisted update");
    equal(await entries.delete({
      id: "a", collection: otherCollection, expectedVersion: 2, expectedStatus: "draft",
    }), { removed: false }, "delete respects collection");
    equal(await entries.get(key("a")), updated, "wrong-collection delete preserves row");
    const deletion = { id: "a", collection, expectedVersion: 2, expectedStatus: "draft" } as const;
    equal(await entries.delete(deletion), { removed: true }, "delete existing row");
    equal(await entries.get(key("a")), null, "deleted get");
    equal(await entries.readById(key("a")), null, "deleted public read");
    equal(await entries.delete(deletion), { removed: false }, "delete missing row");
  }],
  ["entries.version-conflicts", async ({ entries }) => {
    await entries.create(entry("a"));
    const updates = await Promise.allSettled(["first", "second"].map((title) => entries.update({
      id: "a", collection, expectedVersion: 1, data: { title }, now: 200,
    })));
    equal(updates.filter((result) => result.status === "fulfilled").length, 1, "one concurrent update wins");
    const rejected = updates.find((result) => result.status === "rejected");
    assert(rejected?.status === "rejected", "concurrent loser rejects");
    assert(rejected.reason instanceof EntryVersionConflict, "concurrent loser is EntryVersionConflict");
    equal([rejected.reason.id, rejected.reason.expected, rejected.reason.actual], ["a", 1, 2], "OCC details");
    const before = await entries.get(key("a"));
    assert(before !== null, "concurrent winner is persisted");
    equal(before.version, 2, "only one version increment");
    await conflict(() => entries.update({
      id: "a", collection, expectedVersion: 1, data: { title: "stale" }, now: 300,
    }), EntryVersionConflict, 1, 2);
    await conflict(() => entries.transitionStatus({
      id: "a", collection, expectedVersion: 1, expectedStatus: "draft", to: "published", now: 300,
    }), EntryVersionConflict, 1, 2);
    await conflict(() => entries.delete({
      id: "a", collection, expectedVersion: 1, expectedStatus: "draft",
    }), EntryVersionConflict, 1, 2);
    equal(await entries.get(key("a")), before, "version conflicts leave row unchanged");
  }],
  ["entries.status-conflicts", async ({ entries }) => {
    const original = await entries.create(entry("a"));
    await conflict(() => entries.transitionStatus({
      id: "a", collection, expectedStatus: "published", expectedVersion: 1, to: "archived", now: 200,
    }), EntryStatusConflict, "published", "draft");
    await conflict(() => entries.delete({
      id: "a", collection, expectedVersion: 1, expectedStatus: "published",
    }), EntryStatusConflict, "published", "draft");
    equal(await entries.get(key("a")), original, "status conflicts leave row unchanged");
    const published = await entries.transitionStatus({
      id: "a", collection, expectedStatus: "draft", expectedVersion: 1, to: "published", now: 200,
    });
    equal(published, { ...original, status: "published", version: 2, updatedAt: 200 }, "successful status transition");
    equal(await entries.get(key("a")), published, "persisted transition");
  }],
  ["entries.clone-isolation", async ({ entries }) => {
    const data = { title: "Original", nested: { values: ["stored"] } };
    const created = await entries.create({ ...entry("a"), data });
    data.nested.values.push("input mutation");
    created.data["title"] = "returned mutation";
    const expected = { title: "Original", nested: { values: ["stored"] }, locale: null };
    equal((await entries.get(key("a")))?.data, expected, "create data is isolated from storage");
    const readers = [
      () => entries.get(key("a")),
      () => entries.readById(key("a")),
      async () => (await entries.list({ collection })).rows[0],
    ];
    for (const read of readers) {
      const row = await read();
      assert(row != null, "isolation fixture exists");
      const nested = row.data["nested"] as { values: string[] };
      nested.values.push("read mutation");
      equal((await entries.get(key("a")))?.data, expected, "nested read mutation does not persist");
    }
    const replacement = { nested: { values: ["replacement"] } };
    const updated = await entries.update({ id: "a", collection, expectedVersion: 1, data: replacement, now: 200 });
    replacement.nested.values.push("input mutation");
    (updated.data["nested"] as { values: string[] }).values.push("returned mutation");
    equal((await entries.get(key("a")))?.data, { nested: { values: ["replacement"] }, locale: null }, "update data is isolated from storage");
  }],
  ["entries.read-helpers", async ({ entries }) => {
    for (const args of [
      { ...entry("en"), status: "published" as const, now: 100 },
      { ...entry("zh", "zh-TW"), status: "published" as const, now: 200 },
      { ...entry("missing"), data: { slug: "shared", group: "g" }, status: "published" as const, now: 300 },
      { ...entry("null"), data: { slug: "shared", group: "g", locale: null }, status: "published" as const, now: 400 },
      { ...entry("draft"), now: 500 },
      { ...entry("other"), collection: otherCollection, status: "published" as const, now: 600 },
    ]) await entries.create(args);
    const query = { collection, slug: "shared", status: "published" } as const;
    equal((await entries.readBySlug({ ...query, locale: "en" }))?.id, "en", "exact locale");
    equal((await entries.readBySlug({ ...query, locale: "zh-TW" }))?.locale, "zh-TW", "lifted locale");
    equal((await entries.readBySlug({ ...query, locale: null }))?.id, "null", "null locale includes missing/null");
    equal((await entries.readBySlug(query))?.id, "null", "omitted locale accepts all locales");
    equal(await entries.readBySlug({ ...query, locale: "ja" }), null, "unmatched locale");
    equal((await entries.readByDataField({ collection, field: "group", value: "g", status: "published", locale: "en" }))?.id, "en", "data-field read respects status/locale");
    equal(ids(await entries.readByDataFieldIn({ collection, field: "group", values: ["g", "g"], status: "published", locale: null })), ["null", "missing"], "IN read deduplicates values and filters locale");
    equal(await entries.readByDataFieldIn({ collection, field: "group", values: [] }), [], "empty IN read");
    equal(ids(await entries.readByDataFieldIn({ collection, field: "group", values: ["g"], status: "published", latestPerValue: true })), ["null"], "latest parent per join value");
    equal(ids(await entries.readPublished({ collection, limit: 2 })), ["null", "missing"], "published limit/status/collection");
    equal(ids(await entries.readPublished({ collection, locale: "en" })), ["en"], "published exact locale");
    const pageArgs = { collection, locale: "en", includeUnlocalized: true, limit: 2 } as const;
    const page = await entries.readPublishedPage(pageArgs);
    equal(ids(page.rows), ["null", "missing"], "published page merges shared locale and retains order");
    assert(page.nextCursor !== undefined, "published page exposes continuation");
    const next = await entries.readPublishedPage({ ...pageArgs, cursor: page.nextCursor, dataFields: ["slug", "absent"] });
    equal(ids(next.rows), ["en"], "published continuation excludes other locales and drafts");
    equal(next.rows[0]?.data, { slug: "shared", absent: null }, "published metadata projection");
    equal(next.rows[0]?.locale, "en", "metadata projection retains envelope locale");
    equal(next.nextCursor, undefined, "last published page terminates");
    equal(ids(await entries.findManyByDataField({ collection, field: "group", value: "g", limit: 2 })), ["draft", "null"], "findMany includes drafts and honors limit");
    equal((await entries.findByDataField({ collection, field: "slug", value: "shared", status: "published" }))?.id, "null", "repository data-field read");
    equal((await entries.findByDataFields({ collection, fields: { slug: "shared", locale: "en" }, excludeId: "draft" }))?.id, "en", "composite read and excludeId");
    equal(await entries.findByDataFields({ collection, fields: { slug: "absent", locale: "en" } }), null, "unmatched composite read");
    const publicRows = [
      await entries.readById(key("en")),
      await entries.readBySlug({ ...query, locale: "en" }),
      await entries.readByDataField({ collection, field: "slug", value: "shared" }),
      ...await entries.readByDataFieldIn({ collection, field: "group", values: ["g"] }),
      ...await entries.readPublished({ collection }),
      ...(await entries.readPublishedPage({ collection })).rows,
      ...await entries.findManyByDataField({ collection, field: "group", value: "g", limit: 10 }),
    ];
    const allowed = new Set(["id", "collection", "locale", "status", "version", "data", "createdAt", "updatedAt"]);
    for (const row of publicRows) {
      assert(row !== null, "public projection exists");
      equal(Object.keys(row).filter((key) => !allowed.has(key)), [], "public projection excludes persistence fields");
      const stored = await entries.get(key(row.id, row.collection));
      assert(stored !== null, "public row has a stored counterpart");
      const { authorId: _authorId, ...projection } = stored;
      equal(row, projection, "public projection preserves public fields");
    }
  }],
  ["entries.cursors", async ({ entries }) => {
    for (const id of ["a", "d", "b", "c", "e"]) await entries.create(entry(id));
    await entries.create({ ...entry("other"), collection: otherCollection });
    await entries.create({ ...entry("published"), status: "published" });
    const query = { collection, status: "draft", limit: 2 } as const;
    for (const direction of ["asc", "desc"] as const) {
      const sort = { field: "updatedAt", direction };
      const expected = direction === "asc" ? ["a", "b", "c", "d", "e"] : ["e", "d", "c", "b", "a"];
      const first = await entries.list({ ...query, sort });
      equal(ids(first.rows), expected.slice(0, 2), "first page uses stable id tie-break");
      assert(first.nextCursor !== undefined, "first page has next cursor");
      equal(first.previousCursor, undefined, "first page has no previous cursor");
      const second = await entries.list({ ...query, sort, cursor: first.nextCursor });
      equal(ids(second.rows), expected.slice(2, 4), "forward page has no duplicates or skips");
      assert(second.previousCursor !== undefined && second.nextCursor !== undefined, "middle page has both cursors");
      const back = await entries.list({ ...query, sort, cursor: second.previousCursor, cursorDirection: "backward" });
      equal(ids(back.rows), ids(first.rows), "backward cursor restores first page in display order");
      equal(back.previousCursor, undefined, "backward first page has no previous cursor");
      const last = await entries.list({ ...query, sort, cursor: second.nextCursor });
      equal(ids(last.rows), expected.slice(4), "last page");
      equal(last.nextCursor, undefined, "last page has no next cursor");
      equal(ids((await entries.list({ ...query, sort, cursor: first.nextCursor })).rows), ids(second.rows), "cursor can be replayed deterministically");
    }
  }],
  ["views.declarative", async ({ entries, views }) => {
    for (const [id, locale, score, status] of [
      ["a", "en", 2, "published"], ["b", "zh-TW", 3, "published"],
      ["c", "en", 1, "published"], ["draft", "en", 9, "draft"],
      ["ja", "ja", 8, "published"],
    ] as const) await entries.create({ ...entry(id, locale), status, data: { title: id, locale, score } });
    const first = await views.execute({ view: "conformance-ranked", params: { minimum: 0 }, show: 2 });
    equal(first, { rows: [{ id: "b", title: "b", score: 3 }, { id: "a", title: "a", score: 2 }], page: 1, show: 2, hasMore: true }, "View projection, nested AND/OR and ordering");
    const second = await views.execute({ view: "conformance-ranked", params: { minimum: 0 }, show: 2, page: 2 });
    equal(second, { rows: [{ id: "c", title: "c", score: 1 }], page: 2, show: 2, hasMore: false }, "View pagination");
    equal((await views.execute({ view: "conformance-ranked", params: { minimum: 2 }, show: 2 })).rows, [{ id: "b", title: "b", score: 3 }], "View parameter binding");
    equal((await views.execute({ view: "conformance-ranked", params: { minimum: 9 } })).rows, [], "View with no matches");
  }],
];

function entry(id: string, locale = "en"): CreateEntryArgs {
  return {
    id, collection, status: "draft", authorId: "synthetic-author", now: 100,
    data: { title: id, slug: "shared", group: "g", locale },
  };
}

function ids(rows: readonly { readonly id: string }[]): string[] {
  return rows.map(({ id }) => id);
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function equal(actual: unknown, expected: unknown, message: string): void {
  const a = stableJson(actual);
  const e = stableJson(expected);
  assert(a === e, `${message}: expected ${e}, received ${a}`);
}

// Object key order and absent optional properties are not storage contracts.
function stableJson(value: unknown): string | undefined {
  return JSON.stringify(value, (_key, child: unknown) => {
    if (!child || typeof child !== "object" || Array.isArray(child)) return child;
    return Object.fromEntries(Object.entries(child).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
  });
}

async function conflict(
  run: () => Promise<unknown>,
  kind: typeof EntryVersionConflict | typeof EntryStatusConflict,
  expected: number | string,
  actual: number | string,
): Promise<void> {
  try {
    await run();
  } catch (error) {
    assert(error instanceof kind, `expected ${kind.name}, received ${errorMessage(error)}`);
    equal([error.id, error.expected, error.actual], ["a", expected, actual], `${kind.name} details`);
    return;
  }
  throw new Error(`expected ${kind.name}, operation succeeded`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function fixturePlan(): RuntimePlan {
  const schemas = [collection, otherCollection].map((name) => ({
    apiVersion: "cms.mantle.aotter.net/v1", kind: "Schema", metadata: { name },
    spec: {
      title: name, lifecycle: "publishing", localized: true,
      schema: { type: "object", properties: {
        title: { type: "string" }, slug: { type: "string" }, group: { type: "string" },
        locale: { type: ["string", "null"] }, score: { type: "number" }, nested: { type: "object" },
      } },
    },
  }));
  const view = {
    apiVersion: "cms.mantle.aotter.net/v1", kind: "View", metadata: { name: "conformance-ranked" },
    spec: {
      surface: "public", from: collection, fields: ["id", "title", "score"],
      params: { type: "object", required: ["minimum"], properties: { minimum: { type: "number" } } },
      filter: { and: [
        { eq: { field: "status", value: "published" } },
        { or: ["en", "zh-TW"].map((locale) => ({ eq: { field: "locale", value: locale } })) },
        { gt: { field: "score", value: { $param: "minimum" } } },
      ] },
      orderBy: [{ field: "score", direction: "desc" }], limit: 20,
    },
  };
  const parsed = parseManifestSources({
    sources: [{ sourceId: "memory:storage-conformance", text: [...schemas, view].map((atom) => JSON.stringify(atom)).join("\n---\n") }],
  });
  if (!parsed.ok) throw new Error(`Conformance fixture parse failed: ${JSON.stringify(parsed.diagnostics)}`);
  const linked = linkManifestSet(parsed.value);
  if (!linked.ok) throw new Error(`Conformance fixture link failed: ${JSON.stringify(linked.diagnostics)}`);
  const compiled = compileRuntimePlan(linked.value);
  if (!compiled.ok) throw new Error(`Conformance fixture compile failed: ${JSON.stringify(compiled.diagnostics)}`);
  return compiled.value;
}
