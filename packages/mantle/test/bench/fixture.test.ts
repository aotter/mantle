// @ts-nocheck bench files are plain .mjs
/**
 * The training fixture of bench/: its manifests compile for both built-in dialects, its seed is deterministic and
 * Swolhalla-shaped, and every bench item returns rows for the member (and only the member's rows) on a real runtime.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createMantleRuntime } from "../../src/core/index.js";
import * as d1Compile from "../../src/d1/compile/index.js";
import { sqliteStorage } from "../../src/d1/index.js";
import * as pgCompile from "../../src/postgres/compile/index.js";
import { compileLinkedPlan, parseManifestSources, ValidateManifestsUseCase } from "../../src/spec/index.js";
import { nodeSqliteDriver } from "../../bench/lib/drivers.mjs";
import { insertRows } from "../../bench/lib/prepare.mjs";
import { M1_SETS, M1_WORKOUTS, NOISE_OWNERS, NOISE_SETS, NOISE_WORKOUTS, NOW, fixture, rows } from "../../bench/fixtures/training/seed.mjs";
import { handlers } from "../../bench/fixtures/training/handlers.mjs";
import items from "../../bench/fixtures/training/items.mjs";
import config from "../../bench/fixtures/training/mantle.bench.mjs";

const manifests = join(import.meta.dirname, "../../bench/fixtures/training/manifests");
const sources = readdirSync(manifests).filter((f) => f.endsWith(".yaml")).map((f) => ({ sourceId: f, text: readFileSync(join(manifests, f), "utf8") }));

async function compile(dialect) {
  const parsed = parseManifestSources({ sources });
  expect(parsed.ok).toBe(true);
  const validation = ValidateManifestsUseCase.run({ parsed: parsed.value });
  expect(validation.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  return compileLinkedPlan(validation.linked, dialect);
}

describe("fixture manifests", () => {
  for (const [name, dialect] of [["d1", d1Compile], ["postgres", pgCompile]]) {
    it(`compile for ${name}: 6 Views and 3 Procedures`, async () => {
      const compiled = await compile(dialect);
      if (!compiled.ok) throw new Error(JSON.stringify(compiled.diagnostics, null, 1));
      expect(Object.keys(compiled.plan.views)).toHaveLength(6);
      expect(Object.keys(compiled.plan.procedures)).toHaveLength(3);
    });
  }
});

describe("fixture seed", () => {
  it("is deterministic and Swolhalla-shaped", () => {
    expect(rows()).toEqual(rows());
    const { workouts, sets, exercises } = rows();
    expect(exercises).toHaveLength(40);
    expect(exercises[0].name).toBe("Back Squat");
    expect(workouts.filter((w) => w.owner === "m1")).toHaveLength(M1_WORKOUTS);
    expect(sets.filter((s) => s.owner === "m1")).toHaveLength(M1_SETS);
    expect(M1_SETS).toBe(18_720);
    expect(sets.filter((s) => s.owner !== "m1")).toHaveLength(NOISE_SETS);
    expect(workouts.filter((w) => NOISE_OWNERS.includes(w.owner))).toHaveLength(NOISE_OWNERS.length * NOISE_WORKOUTS);
    const m1 = workouts.filter((w) => w.owner === "m1");
    expect(m1.at(-1).id).toBe(fixture.latestWorkoutId);
    expect([...m1].sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1))[0].id).toBe(fixture.latestWorkoutId);
    expect(Date.parse(m1.at(-1).startedAt)).toBeLessThan(Date.parse(NOW));
    // ids are unique and every enum value is a declared one
    expect(new Set(sets.map((s) => s.id)).size).toBe(sets.length);
    expect(new Set(sets.map((s) => s.tag))).toEqual(new Set(["warmup", "working"]));
  });
});

describe("fixture on a runtime", () => {
  it("every item returns at least minRows for the member, and the scoped Views see nobody else's rows", async () => {
    const compiled = await compile(d1Compile);
    if (!compiled.ok) throw new Error("fixture does not compile");
    const driver = nodeSqliteDriver(":memory:");
    try {
      const storage = sqliteStorage(driver);
      await storage.prepare(compiled.plan);
      await insertRows(driver, compiled.plan, storage.dialect.codec, rows());
      const runtime = await createMantleRuntime({ plan: compiled.plan, handlers, storage, schedules: true, now: () => Date.parse(NOW) * 1000 });
      const ctxFor = (who) => ({ runtime, caller: config.callers[who], store: runtime.store.as(config.callers[who], { kind: "internal", id: "bench" }), fixture });
      for (const item of items) {
        const ctx = ctxFor(item.caller);
        const args = item.prepare ? await item.prepare(ctx) : undefined;
        const result = await item.call(ctx, args);
        expect(item.rows(result), item.name).toBeGreaterThanOrEqual(item.minRows);
      }
      // the other owner sees exactly their own rows: this also proves the seed bound the scope column
      const noise = ctxFor("noise");
      expect((await noise.store.view("workout-list", { limit: 500 })).rows).toHaveLength(NOISE_WORKOUTS);
      expect((await noise.store.view("workout-sets", { input: { workoutId: fixture.latestWorkoutId } })).rows).toHaveLength(0);
      expect((await noise.store.view("workout-sets", { input: { workoutId: "w-o2-0001" } })).rows).toHaveLength(20);
      expect((await noise.store.select({ from: "sets", limit: 500 })).rows).toHaveLength(500);
      const member = ctxFor("member");
      expect((await member.store.view("workout-list", { limit: 500 })).rows).toHaveLength(500);
    } finally {
      driver.db.close();
    }
  }, 120_000);
});
