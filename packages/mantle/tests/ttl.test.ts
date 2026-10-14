import {afterAll, expect, test} from "bun:test";
import {Database} from "bun:sqlite";
import {resolve} from "node:path";
import {rm} from "node:fs/promises";
import {build} from "esbuild";
import {generateOrThrow, loadFixtureSources, writeGenerated} from "./apps/link.js";
import {toCloudflareCron} from "../src/kernel/cron.js";
import type {Target} from "../src/domain/model.js";
const dir = resolve(import.meta.dir, "apps/.generated", `ttl-${crypto.randomUUID()}`);
afterAll(() => rm(dir, {recursive: true, force: true}));
import {verifyTtl} from "./ttl-scenarios.js";
async function scenario(target: Target, db: any, native: (sql: string, values?: any[]) => Promise<any>) {
  const sources = (await loadFixtureSources("store-extra.yaml")).map(s => ({...s, text: s.text.replace("expireAfterSeconds: 0", "expireAfterSeconds: 2")}));
  const files = await generateOrThrow(target, sources);
  await native(files["schema.sql"]!);
  const path = resolve(dir, target); await writeGenerated(path, files);
  const app = await import(resolve(path, "generated.ts"));
  await verifyTtl(app, db, target.endsWith("sqlite") || target.endsWith("d1"), native, 2);
}
for (const target of ["bun-sqlite"] as const) test(`TTL ${target} nonzero expiry, scope, bounded scan and authority`, async () => {
  const db = new Database(":memory:");
  try {await scenario(target, db, async (sql, values) => values ? db.query(sql).all(...values) : /^SELECT/.test(sql) ? db.query(sql).all() : db.exec(sql));} finally {db.close();}
});

test("TTL entries are optional and tree-shake out of unrelated operations", async () => {
  const files = await generateOrThrow("bun-sqlite", await loadFixtureSources("store-extra.yaml"));
  const path = resolve(dir, "bundle"); await writeGenerated(path, files);
  const bundle = await build({entryPoints: [resolve(path, "procedures/create-catalog-item.ts")], bundle: true, write: false, platform: "node", format: "esm"});
  expect(bundle.outputFiles[0]!.text).not.toContain("TTL maintenance");
  const none = await generateOrThrow("bun-sqlite", await loadFixtureSources("purchase.yaml"));
  expect(none["generated.ts"]).not.toContain("sweepTtl");
});
test("Cloudflare cron maps POSIX weekdays and refuses ambiguous schedules", () => {
  expect(toCloudflareCron("0 0 * * 0,2-6")).toBe("0 0 * * 1,3-7");
  expect(toCloudflareCron("*/5 * * JAN MON-FRI")).toBe("*/5 * * JAN MON-FRI");
  for (const cron of ["0 0 * * 7", "60 * * * *", "0 0 1 * 1", "* * * *", "* * * * */0"]) expect(() => toCloudflareCron(cron)).toThrow();
});
test("TTL scans advance even when a native trigger suppresses deletion", async () => {
  const files = await generateOrThrow("bun-sqlite", await loadFixtureSources("store-extra.yaml"));
  const path = resolve(dir, "suppressed"); await writeGenerated(path, files);
  const app = await import(resolve(path, "generated.ts")), db = new Database(":memory:");
  try {
    db.exec(files["schema.sql"]!);
    db.exec("INSERT INTO session_notes (id,created_at,owner,body,expiresat) VALUES ('held',0,'a','held',0); CREATE TRIGGER hold_note BEFORE DELETE ON session_notes BEGIN SELECT RAISE(IGNORE); END");
    const caller = {kind: "system", reason: "cleanup"};
    const page = await app.procedures["session_notes.sweepExpired"](db, caller, {limit: 1});
    expect(page.scanned).toBe(1); expect(page.removed).toBe(0);
    expect(await app.procedures["session_notes.sweepExpired"](db, caller, {cursor: page.nextCursor})).toEqual({scanned: 0, removed: 0});
    expect(db.query("SELECT id FROM session_notes").all()).toEqual([{id: "held"}]);
    // Rejection precedes any database access, including forged admin callers.
    await expect(app.procedures["session_notes.sweepExpired"]({}, {kind: "user", role: "admin"}, {})).rejects.toMatchObject({code: "AUTH_DENIED"});
  } finally {db.close();}
});
