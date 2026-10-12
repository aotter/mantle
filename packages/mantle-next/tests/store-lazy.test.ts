import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { bundle } from "../src/infrastructure/bundle.js";
import { generateOrThrow, loadFixtureSources, loadGenerated, writeGenerated } from "./apps/link.js";
import { user } from "./apps/fixtures.js";

const targets = ["bun-sqlite", "bun-postgres", "cloudflare-d1", "cloudflare-postgres"] as const;
const ref = { sourceId: "lazy-ref.yaml", text: `apiVersion: cms.mantle.aotter.net/v2
kind: Procedure
metadata: {name: echo}
spec:
  input: {type: object, required: [message], properties: {message: {type: string}}, additionalProperties: false}
  output: {type: object, required: [message], properties: {message: {type: string}}, additionalProperties: false}
  handler: {ref: app.echo}
` };

for (const target of targets) test(`${target}: importing generated code runs no Store initializer; callers and handlers stay independent`, async () => {
  const dir = await mkdtemp(resolve(import.meta.dir, "apps/.generated/lazy-store-"));
  try {
    for (const handlers of [false, true]) {
      const counter = resolve(dir, handlers ? "ref-counter.ts" : "counter.ts");
      // Instrument only this fixture's import, without global mocks that could poison another suite.
      await writeFile(counter, `import {createStore as native} from ${JSON.stringify(resolve(import.meta.dir, "../src/kernel/store.ts"))};export let calls=0;export function createStore(...args:any[]){calls++;return (native as any)(...args);}`);
      const files = await generateOrThrow(target, [...await loadFixtureSources(), ...(handlers ? [ref] : [])]);
      const app = await loadGenerated(files["generated.ts"]!.replace('"@aotter/mantle-next/store"', JSON.stringify(counter)));
      const probe = await import(counter);
      expect(probe.calls).toBe(0);
      const queries: unknown[][] = [];
      const read = (_sql: string, values: unknown[]) => { queries.push(values); return []; };
      const handle = () => target === "bun-sqlite" ? { query: (sql: string) => ({ all: (...values: unknown[]) => read(sql, values) }) }
        : target === "cloudflare-d1" ? { prepare: (sql: string) => ({ bind: (...values: unknown[]) => ({ all: async () => ({ results: read(sql, values) }) }) }) }
        : { unsafe: async (sql: string, values: unknown[]) => read(sql, values) };
      const db = handle(), otherDb = handle(), a = user("owner-a"), b = user("owner-b"), system = { kind: "system", reason: "fixture maintenance" };
      await app.views["purchase-shared"](db, a, {});
      expect(probe.calls).toBe(0); expect(queries).toEqual([["owner-a"]]);
      const options = (expectedDb: unknown, caller: unknown, message: string) => ({ handlers: { echo: async (ctx: any) => {
        expect(ctx.db).toBe(expectedDb); expect(ctx.caller).toBe(caller); expect(typeof ctx.store.collection).toBe("function");
        return { message };
      } } });
      const one = handlers ? app.store(db, a, options(db, a, "one")) : app.store(db, a);
      const two = handlers ? app.store(otherDb, b, options(otherDb, b, "two")) : app.store(otherDb, b);
      const trusted = handlers ? app.store(db, system, options(db, system, "system")) : app.store(db, system);
      expect(one).not.toBe(two); expect(one).not.toBe(trusted);
      expect(probe.calls).toBe(1); expect(queries).toHaveLength(1);
      await one.views["purchase-shared"]({}); await two.views["purchase-shared"]({}); await trusted.views["purchase-shared"]({});
      expect(queries).toEqual([["owner-a"], ["owner-a"], ["owner-b"], []]);
      if (handlers) {
        expect(await one.procedures.echo({ message: "input" })).toEqual({ message: "one" });
        expect(await two.procedures.echo({ message: "input" })).toEqual({ message: "two" });
        expect(await trusted.procedures.echo({ message: "input" })).toEqual({ message: "system" });
      }
      expect(probe.calls).toBe(1); expect(queries).toHaveLength(4);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("unminified direct operation deployment excludes an unused Store and its lazy initializer", async () => {
  const dir = await mkdtemp(resolve(import.meta.dir, "apps/.generated/lazy-store-bundle-"));
  try {
    await writeGenerated(dir, await generateOrThrow("cloudflare-d1", [...await loadFixtureSources(), ref]), false);
    const entry = resolve(dir, "worker.ts");
    await writeFile(entry, 'export { default } from "./views/purchase-shared.ts";');
    const meta = await bundle(entry, resolve(dir, "out"));
    const retained = Object.values(meta.outputs).flatMap(output => Object.entries(output.inputs).filter(([, input]) => input.bytesInOutput > 0).map(([file]) => file));
    expect(retained.some(file => /\/kernel\/store\.[jt]s$/.test(file))).toBe(false);
    expect(retained.some(file => /\/kernel\/paging\.[jt]s$/.test(file))).toBe(false);
    const storeEntry = resolve(dir, "store-worker.ts");
    await writeFile(storeEntry, 'import {store} from "./generated.ts";export const count=(db:any)=>store(db,{kind:"system",reason:"fixture"},{handlers:{echo:async()=>({message:"fixture"})}}).collection("purchase_requests").count();');
    const used = await bundle(storeEntry, resolve(dir, "store-out"));
    expect(Object.values(used.outputs).some(output => Object.entries(output.inputs).some(([file, input]) => input.bytesInOutput > 0 && /\/kernel\/store\.[jt]s$/.test(file)))).toBe(true);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
