import { afterEach, expect, it } from "vitest";
import { LocalD1 } from "../../src/cloudflare/testing/d1.js";
import { DiagnosticError, type SiteDefaults } from "../../src/spec/index.js";
import { prepareSite } from "../../src/d1/site.js";
import { convergeStorage } from "../../src/d1/storage.js";

const open: LocalD1[] = [];
const db = async () => { const d1 = await LocalD1.create(); open.push(d1); return d1; };
afterEach(async () => { await Promise.all(open.splice(0).map((d) => d.dispose())); });

const photo = { name: "cover", required: ["image/jpeg"], maxBytes: { "image/jpeg": 1000 } };
const codes = async (p: Promise<unknown>) => p.then(() => [], (e) => (e instanceof DiagnosticError ? e.diagnostics.map((d) => [d.code, d.path]) : [String(e)]));

it("creates the three product tables once, each with its 0.1.x ledger id, and two isolates racing on it both boot", async () => {
  const d1 = await db();
  expect((await Promise.allSettled([prepareSite(d1, {}), prepareSite(d1, {})])).map((r) => r.status)).toEqual(["fulfilled", "fulfilled"]);
  await prepareSite(d1, {});
  expect(await d1.all("SELECT id FROM _mantle_migrations ORDER BY id")).toEqual([{ id: "0001-init" }, { id: "0002-media-assets" }, { id: "0003-pending-media-uploads" }]);
  expect(await d1.all("SELECT name FROM sqlite_schema WHERE type = 'table' AND name IN ('site_config', 'media_assets', 'pending_media_uploads') ORDER BY name"))
    .toEqual([{ name: "media_assets" }, { name: "pending_media_uploads" }, { name: "site_config" }]);
});

it("refuses a product table Mantle did not create, and takes one its own _mantle_migrations ledger row proves", async () => {
  const foreign = await db();
  await foreign.exec("CREATE TABLE Media_Assets (id TEXT)");
  expect(await codes(prepareSite(foreign, {}))).toEqual([["STORAGE_TABLE_NOT_OWNED", "storage:Media_Assets"]]);
  expect(await foreign.all("SELECT id FROM _mantle_migrations WHERE id = '0002-media-assets'")).toEqual([]);

  const owned = await db();
  await owned.exec("CREATE TABLE _mantle_migrations (id TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)");
  await owned.exec("CREATE TABLE site_config (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  await owned.exec("INSERT INTO site_config VALUES ('title', 'Old'); INSERT INTO _mantle_migrations VALUES ('0001-init', 0)");
  expect(await (await prepareSite(owned, { title: "New" })).read()).toMatchObject({ title: "Old" });
});

it("a Schema may not take a product table's name", async () => {
  const d1 = await db();
  const r = await convergeStorage(d1, { site_config: { fields: {} }, pending_media_uploads: { fields: {} }, sites_users: { fields: {} } }, { fingerprint: "f" });
  expect(r.blocked.map((b) => [b.schema, b.code])).toEqual([["site_config", "STORAGE_TABLE_NOT_OWNED"], ["pending_media_uploads", "STORAGE_TABLE_NOT_OWNED"]]);
});

it("seeds operator fields once and syncs deployment fields every boot, skipping blank defaults", async () => {
  const d1 = await db();
  expect(await (await prepareSite(d1, {})).read()).toEqual({
    title: "CMS", description: "", origin: "", locales: [], canonicalLocale: null, brand: "AotterMantle", icons: expect.any(Array), media: { purposes: [] },
  });
  const first: SiteDefaults = { brand: "B1", title: "T1", origin: "https://a.test", locales: ["en", "zh-TW"], media: { purposes: [photo] } };
  const site = await prepareSite(d1, first);
  await site.updateSettings({ title: "Owner's title", description: "" });
  const icons = [{ src: "/i.png", mimeType: "image/png" as const, sizes: ["64x64"] }];
  await prepareSite(d1, { brand: "B2", title: "T2", description: "D2", origin: "https://b.test", icons, locales: ["en"], media: { purposes: [{ ...photo, maxBytes: { "image/jpeg": 5 } }] } });
  expect(await site.read()).toMatchObject({ brand: "B1", title: "Owner's title", description: "", origin: "https://b.test", locales: ["en"], canonicalLocale: "en", icons, media: { purposes: [{ maxBytes: { "image/jpeg": 5 } }] } });
  // a blank default is not a declaration
  await prepareSite(d1, { origin: "", locales: [] });
  expect(await site.read()).toMatchObject({ origin: "https://b.test", locales: ["en"] });
  await expect(prepareSite(d1, { locales: ["zh-Hant"] })).rejects.toThrow(/locale/);
  for (const origin of ["https://a.test/", "https://a.test/blog", "ftp://a.test", "a.test"]) await expect(prepareSite(d1, { origin })).rejects.toThrow(/absolute http\(s\) origin/);
  expect(await site.read()).toMatchObject({ origin: "https://b.test" });
});
