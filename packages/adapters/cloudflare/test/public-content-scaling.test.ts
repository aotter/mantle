import { describe, expect, it, vi } from "vitest";
import type { SchemaManifest, SiteConfig } from "@aotter/mantle-spec";
import { CANONICAL_MIGRATIONS } from "@aotter/mantle-runtime";
import { ComposeLlmsTxtUseCase, ComposeSitemapUseCase, RenderListLiveUseCase, TemplateRegistry, createPublicPathResolver } from "@aotter/mantle-web";
import { DatabaseEntryRepository } from "../../../mantle-runtime/src/infrastructure/persistence/DatabaseEntryRepository.js";
import { schemaTableMigrations } from "../../../mantle-runtime/src/infrastructure/storage/SqliteSchemaTables.js";
import { D1DatabaseDriver } from "../src/bindings/D1DatabaseDriver.js";
import { sqliteD1 } from "./fakes/sqlite-d1.js";

const locales = ["en", "zh-TW", "ja", "fr", "de", "es", "ko", "it", "pt", "nl"];
const site: SiteConfig = { title: "Fixture", brand: "Fixture", origin: "https://example.test", locales, canonicalLocale: "en" };
const bytes = (value: unknown) => new TextEncoder().encode(typeof value === "string" ? value : JSON.stringify(value)).byteLength;

/** Real SQLite result transfer, not fabricated D1 rows_read or remote timings. */
function fixture() {
  const { db, sqlite } = sqliteD1();
  for (const migration of CANONICAL_MIGRATIONS) sqlite.exec(migration.sql);
  const schema = (name: string, properties: Record<string, SchemaManifest["spec"]["schema"]>, extra: Partial<SchemaManifest["spec"]> = {}): SchemaManifest => ({
    apiVersion: "cms.mantle.aotter.net/v1", kind: "Schema", metadata: { name },
    spec: { title: name, schema: { type: "object", properties }, ...extra },
  });
  const schemas = new Map<string, SchemaManifest>([
    ["shared", schema("shared", { slug: { type: "string" }, title: { type: "string" }, body: { type: "string" } })],
    ["posts", schema("posts", { slug: { type: "string" }, locale: { type: "string" }, title: { type: "string" }, body: { type: "string" } })],
    ["parents", schema("parents", { slug: { type: "string" }, title: { type: "string" }, marker: { type: "string" }, coverAssetId: { type: "string" } }, { indexes: [["slug"]] })],
    ["translations", schema("translations", { slug: { type: "string" }, locale: { type: "string" }, title: { type: "string" }, imageAssetId: { type: "string" } }, { localized: true, translates: { parent: "parents", on: "slug" }, indexes: [["slug"]] })],
  ]);
  for (const migration of schemaTableMigrations(schemas.values())) sqlite.exec(migration.sql);
  const results: { rows: number; dataBytes: number; resultBytes: number }[] = [];
  const prepare = db.prepare.bind(db);
  const observe = (statement: D1PreparedStatement): D1PreparedStatement => new Proxy(statement, {
    get(target, key) {
      if (key === "bind") return (...values: unknown[]) => observe(target.bind(...values));
      if (key === "all") return async () => {
        const result = await target.all<{ data?: string }>();
        results.push({ rows: result.results.length, dataBytes: bytes(result.results), resultBytes: bytes(result.results) });
        return result;
      };
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  vi.spyOn(db, "prepare").mockImplementation((sql) => observe(prepare(sql)));
  return { sqlite, results, reader: new DatabaseEntryRepository(new D1DatabaseDriver(db), schemas) };
}

// Full Cartesian fixture matrix, including complete discovery traversal. The
// source bodies are 64 B / 4 KiB; the separate runtime case covers >1 MiB entries.
for (const count of [100, 10_000, 50_000]) for (const bodyBytes of [64, 4096]) for (const localeCount of [1, 3, 10]) {
  it(`bounds public pages and discovers all ${count} rows / ${bodyBytes} B / ${localeCount} locales`, async () => {
    const { sqlite, reader, results } = fixture();
    try {
      const activeLocales = locales.slice(0, localeCount);
      const currentSite = { ...site, locales: activeLocales };
      const inserts = {
        posts: sqlite.prepare(`INSERT INTO posts (_mantle_id, _mantle_status, _mantle_version, _mantle_author_id, _mantle_created_at, _mantle_updated_at, slug, locale, title, body) VALUES (?, 'published', 1, 'private-author', 1, ?, ?, ?, ?, ?)`),
        shared: sqlite.prepare(`INSERT INTO shared (_mantle_id, _mantle_status, _mantle_version, _mantle_author_id, _mantle_created_at, _mantle_updated_at, slug, title, body) VALUES (?, 'published', 1, 'private-author', 1, ?, ?, ?, ?)`),
      };
      sqlite.exec("BEGIN");
      const body = "x".repeat(bodyBytes);
      for (let index = 0; index < count; index++) {
        const locale = index % 2 ? activeLocales[Math.floor(index / 2) % localeCount] : undefined;
        const id = `entry-${String(index).padStart(6, "0")}`;
        const updated = Math.floor(index / 3);
        if (locale) inserts.posts.run(id, updated, `item-${index}`, locale, `Title ${index}`, body);
        else inserts.shared.run(id, updated, `item-${index}`, `Title ${index}`, body);
      }
      sqlite.exec("COMMIT; ANALYZE");
      const templates = new TemplateRegistry();
      templates.registerListTemplate("shared", ({ entries }) => entries.map((entry) => `<article>${entry.id}</article>`).join(""));
      const list = new RenderListLiveUseCase(reader, templates, new Map());
      const cpu = process.cpuUsage();
      const started = performance.now();
      const cold = await list.execute({ site: currentSite, collection: "shared", locale: "en", contentLocale: null, limit: 20 });
      const coldResult = results.splice(0);
      expect(cold!.html.match(/<article>/g)).toHaveLength(20);
      expect(cold!.nextCursor).toBeDefined();
      expect(coldResult).toHaveLength(1);
      expect(coldResult[0]!.rows).toBe(21); // One continuation lookahead.
      expect(coldResult[0]!.dataBytes).toBeLessThan(21 * (bodyBytes + 250));
      const warm = await list.execute({ site: currentSite, collection: "shared", locale: "en", contentLocale: null, limit: 20 });
      expect(warm).toEqual(cold);
      expect(results.splice(0)).toEqual(coldResult);

      const paths = createPublicPathResolver({ collectionRoutes: { posts: { segment: "posts" }, shared: { segment: "shared" } } });
      const llms = new ComposeLlmsTxtUseCase(reader, paths);
      const urls = new Set<string>();
      let cursor: string | undefined;
      let llmsCalls = 0;
      let llmsResultBytes = 0;
      do {
        const page = await llms.execute({ site: currentSite, collections: ["posts", "shared"], locales: activeLocales, cursor,
          pathFor: (entry, locale) => entry.locale ? paths.forEntry(entry) : `/${locale.toLowerCase()}/shared/${entry.data.slug}` });
        const calls = results.splice(0);
        expect(calls).toHaveLength(1); // Shared content is read once, regardless of locales.
        expect(calls[0]!.rows).toBeLessThanOrEqual(51);
        expect(calls[0]!.dataBytes).toBeLessThanOrEqual(1_048_576);
        llmsCalls++;
        llmsResultBytes += calls[0]!.resultBytes;
        expect(page?.body).not.toContain("private-author");
        for (const match of (page?.body ?? "").matchAll(/\]\((https:\/\/[^)]+)\)/g)) {
          expect(urls.has(match[1]!)).toBe(false);
          urls.add(match[1]!);
        }
        cursor = page?.nextCursor;
      } while (cursor);
      expect(llmsCalls).toBe(Math.ceil(count / 50));
      expect(urls.size).toBe(count / 2 * (1 + localeCount));
      const sitemap = new ComposeSitemapUseCase(reader);
      const sitemapRequest = { site: currentSite, collections: ["posts", "shared"], dataFields: ["slug"], pathFor: (entry: Parameters<typeof paths.forEntry>[0]) => entry.locale
        ? paths.forEntry(entry) : activeLocales.map((locale) => `/${locale.toLowerCase()}/shared/${entry.data.slug}`) };
      const index = await sitemap.index(sitemapRequest, (partCursor) => `/sitemap.xml?part=1${partCursor ? `&cursor=${encodeURIComponent(partCursor)}` : ""}`);
      const parts = [...index.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => new URL(match[1]!.replace(/&amp;/g, "&")));
      expect(parts).toHaveLength(Math.ceil(count / 2000));
      results.splice(0);
      let sitemapBytes = 0;
      for (const part of parts) {
        const page = await sitemap.execute({ ...sitemapRequest, cursor: part.searchParams.get("cursor") ?? undefined });
        const calls = results.splice(0);
        expect(calls.length).toBeLessThanOrEqual(2);
        expect(calls.reduce((total, call) => total + call.dataBytes, 0)).toBeLessThan(2001 * 250); // No body transfer, even at 50k rows.
        sitemapBytes += bytes(page.body);
        for (const match of page.body.matchAll(/<loc>([^<]+)<\/loc>/g)) expect(urls.delete(`${match[1]}.md`)).toBe(true);
      }
      expect(urls.size).toBe(0);
      const elapsedCpu = process.cpuUsage(cpu);
      // Diagnostic only: host-dependent SQLite + render + assertions, not Worker CPU.
      process.stdout.write(JSON.stringify({ fixture: "public-content-scaling-v1", count, bodyBytes, localeCount,
        list: coldResult[0], llmsCalls, llmsResultBytes, sitemapBytes,
        traversalWallMs: performance.now() - started, traversalCpuMs: (elapsedCpu.user + elapsedCpu.system) / 1000,
        processMaxRssKiB: process.resourceUsage().maxRSS }) + "\n");
    } finally { sqlite.close(); }
  }, 120_000);
}

describe("bounded list joins", () => {
  it("keeps child order and overrides, skips missing/draft parents, batches media, and excludes drafts", async () => {
    const { sqlite, reader } = fixture();
    try {
      const schemas = new Map<string, SchemaManifest>([["translations", {
        apiVersion: "cms.mantle.aotter.net/v1", kind: "Schema", metadata: { name: "translations" },
        spec: { title: "Translations", localized: true, lifecycle: "publishing", schema: { type: "object" }, translates: { parent: "parents", on: "slug" } },
      }]]);
      const parentInsert = sqlite.prepare(`INSERT INTO parents (_mantle_id, _mantle_status, _mantle_version, _mantle_author_id, _mantle_created_at, _mantle_updated_at, slug, title, marker, coverAssetId) VALUES (?, ?, 1, 'private-author', 1, ?, ?, ?, ?, ?)`);
      const childInsert = sqlite.prepare(`INSERT INTO translations (_mantle_id, _mantle_status, _mantle_version, _mantle_author_id, _mantle_created_at, _mantle_updated_at, slug, locale, title, imageAssetId) VALUES (?, ?, 1, 'private-author', 1, ?, ?, ?, ?, ?)`);
      for (const [index, status] of ["published", "draft"].entries()) {
        parentInsert.run(`parent-${index}`, status, index, `slug-${index}`, "Parent", status, "cover");
      }
      for (let index = 0; index < 100; index++) {
        parentInsert.run(`duplicate-${index}`, "published", -index - 1, "slug-0", null, "obsolete", null);
      }
      for (let index = 0; index < 4; index++) {
        childInsert.run(`child-${index}`, index === 3 ? "draft" : "published", 10 - index, `slug-${index}`, "en", "Child", "inline");
      }
      const templates = new TemplateRegistry();
      const rendered: unknown[] = [];
      templates.registerListTemplate("translations", ({ entries, mediaAssets }) => { rendered.push({ entries, assets: [...(mediaAssets?.keys() ?? [])] }); return "List"; });
      const resolveMany = vi.fn(async () => new Map());
      const join = vi.spyOn(reader, "readByDataFieldIn");
      const list = new RenderListLiveUseCase(reader, templates, schemas, { resolveMany });
      const first = await list.execute({ site, collection: "translations", locale: "en", limit: 2 });
      expect(join).toHaveBeenCalledTimes(1);
      expect(await join.mock.results[0]!.value).toHaveLength(1);
      expect(join).toHaveBeenCalledWith(expect.objectContaining({ values: ["slug-0", "slug-1"], status: "published", locale: null }));
      expect(resolveMany).toHaveBeenCalledTimes(1);
      expect(resolveMany.mock.calls[0]).toEqual([["cover", "inline"]]);
      expect(rendered[0]).toMatchObject({ entries: [
        { id: "child-0", data: { title: "Child", marker: "published", coverAssetId: "cover" } },
        { id: "child-1", data: { title: "Child" } },
      ] });
      expect(JSON.stringify(rendered[0])).not.toContain('"marker":"draft"');
      expect(JSON.stringify(rendered[0])).not.toContain("private-author");
      await list.execute({ site, collection: "translations", locale: "en", limit: 2, cursor: first?.nextCursor });
      expect(rendered[1]).toMatchObject({ entries: [{ id: "child-2" }] });
      expect(JSON.stringify(rendered)).not.toContain("child-3");
    } finally { sqlite.close(); }
  });
});
