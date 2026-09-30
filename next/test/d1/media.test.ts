import { afterAll, beforeAll, expect, it } from "vitest";
import { LocalD1 } from "../../src/cloudflare/testing/d1.js";
import type { DatabaseDriver, MediaStorage } from "../../src/core/index.js";
import { mediaLibrary } from "../../src/d1/media.js";
import { prepareSite } from "../../src/d1/site.js";
import { DiagnosticError } from "../../src/spec/index.js";

let d1: LocalD1;
beforeAll(async () => { d1 = await LocalD1.create(); await prepareSite(d1, {}); }, 60_000);
afterAll(() => d1.dispose());

const storage = {} as MediaStorage;
/** Runs `race` on the database just before the library's write reaches it, as a concurrent request would. */
const racing = (race: string): DatabaseDriver => ({
  async batch(statements) {
    if (statements[0]?.sql.startsWith("UPDATE media_assets")) await d1.exec(race);
    return d1.batch(statements);
  },
});
const seed = () => d1.exec("DELETE FROM media_assets; INSERT INTO media_assets (id, created_at, alt, caption, variants) VALUES ('m', 1, 'a0', 'c0', '[]')");

it("update writes only the patched column, so a concurrent edit of the other one stands", async () => {
  await seed();
  expect(await mediaLibrary(racing("UPDATE media_assets SET caption = 'c1' WHERE id = 'm'"), storage, async () => []).update("m", { alt: "a1" })).toMatchObject({ alt: "a1", caption: "c1" });
});

it("update of a row deleted meanwhile is MEDIA_ASSET_NOT_FOUND and does not bring it back", async () => {
  await seed();
  const e = await mediaLibrary(racing("DELETE FROM media_assets WHERE id = 'm'"), storage, async () => []).update("m", { alt: "a1" }).catch((x) => x);
  expect(e instanceof DiagnosticError && e.diagnostics[0]!.code).toBe("MEDIA_ASSET_NOT_FOUND");
  expect(await d1.all("SELECT id FROM media_assets")).toEqual([]);
});
