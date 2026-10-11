// @ts-nocheck test code over loosely typed plans and rows
/**
 * ADR-0044 decision 7 (amended): a plan's input and output validators are built once per plan object, each on its first use,
 * so a cold isolate builds only what its first request reaches.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("../../src/spec/domain/service/JsonSchemaToZod.js", async (importOriginal) => {
  const m = await importOriginal<typeof import("../../src/spec/domain/service/JsonSchemaToZod.js")>();
  return { ...m, jsonSchemaToZod: vi.fn(m.jsonSchemaToZod) };
});

import { LocalD1 } from "../../src/cloudflare/testing/d1.js";
import { createMantle, createMantleRuntime } from "../../src/core/index.js";
import { planValidators } from "../../src/core/runtime/validators.js";
import { sqliteStorage } from "../../src/d1/index.js";
import { jsonSchemaToZod } from "../../src/spec/domain/service/JsonSchemaToZod.js";
import { anonymous, compile, deterministic, handlers, user } from "./lowered-fixture.js";

const built = vi.mocked(jsonSchemaToZod);
let plan, d1;
beforeAll(async () => { plan = await compile(); d1 = await LocalD1.create(); }, 60_000);
afterAll(() => d1?.dispose());

const failure = (p) => p.then(() => undefined, (e) => e);
const inv = (procedure, input) => ({ procedure, input, caller: user("o1"), cause: { kind: "http", id: "c1" } });

describe("planValidators", () => {
  it("returns the same object for the same plan and builds nothing until an entry is used", () => {
    const own = structuredClone(plan);
    built.mockClear();
    const a = planValidators(own);
    expect(built).toHaveBeenCalledTimes(0);
    expect(planValidators(own)).toBe(a);
    expect(planValidators(structuredClone(own))).not.toBe(a); // a different plan object is a different plan
  });

  it("builds each entry once, on its first use", () => {
    const own = structuredClone(plan);
    const v = planValidators(own);
    built.mockClear();
    expect(v.procedure("add-item", "input")).toBe(v.procedure("add-item", "input"));
    expect(built).toHaveBeenCalledTimes(1);
    expect(v.view("low-stock")).toBe(v.view("low-stock"));
    expect(v.view("shelf")).toBeUndefined(); // no declared input
    expect(built).toHaveBeenCalledTimes(2);
  });
});

describe("createMantle and a first call", () => {
  it("builds no validator at construction, only the ones a call reaches, and shares them with the next runtime", async () => {
    const own = structuredClone(plan);
    built.mockClear();
    const service = { handlers, fetch: () => new Response("ok") };
    const m = createMantle(service, { plan: own, storage: () => sqliteStorage(d1) });
    expect(m).toBeDefined();
    const runtime = await createMantleRuntime({ plan: own, handlers, storage: sqliteStorage(d1), schedules: true, ...deterministic() });
    expect(built).toHaveBeenCalledTimes(0);
    await runtime.invokeProcedure(inv("add-item", { name: "apple", stock: 5 }));
    const afterCall = built.mock.calls.length; // add-item, and whatever its lifecycle hooks invoke
    const every = Object.keys(own.procedures).length * 2 + Object.values(own.views).filter((v) => v.input).length;
    expect(afterCall).toBeGreaterThan(0);
    expect(afterCall).toBeLessThan(every);
    await runtime.store.as(user("o1")).view("low-stock", { input: { max: 10 } });
    expect(built).toHaveBeenCalledTimes(afterCall + 1);
    const again = await createMantleRuntime({ plan: own, handlers, storage: sqliteStorage(d1), schedules: true, ...deterministic() });
    await again.invokeProcedure(inv("add-item", { name: "pear", stock: 1 }));
    await again.store.as(user("o1")).view("low-stock", { input: { max: 3 } });
    expect(built).toHaveBeenCalledTimes(afterCall + 1);
  });
});

describe("diagnostics are unchanged", () => {
  it("reports INPUT_VALIDATION_FAILED for a Procedure input, with path, expected and value", async () => {
    const rt = await createMantleRuntime({ plan, handlers, storage: sqliteStorage(await LocalD1.create()), schedules: true, ...deterministic() });
    const e = await failure(rt.invokeProcedure(inv("add-item", { name: 1, stock: 2 })));
    expect(e.diagnostic).toMatchObject({ code: "INPUT_VALIDATION_FAILED", path: "manifest:Procedure/add-item#/input/name", value: 1 });
    expect(e.diagnostic.expected).toEqual(expect.any(String));
  });

  it("reports INPUT_VALIDATION_FAILED for a View input", async () => {
    const rt = await createMantleRuntime({ plan, handlers, storage: sqliteStorage(await LocalD1.create()), schedules: true, ...deterministic() });
    const e = await failure(rt.store.as(user("o1")).view("low-stock", { input: { max: "x" } }));
    expect(e.diagnostic).toMatchObject({ code: "INPUT_VALIDATION_FAILED", message: expect.stringContaining("View 'low-stock' input does not match its schema at /max") });
  });

  it("reports OUTPUT_VALIDATION_FAILED for a handler result that breaks the output schema, without the value", async () => {
    const bad = { audit: () => "not an object" };
    const rt = await createMantleRuntime({ plan, handlers: bad, storage: sqliteStorage(await LocalD1.create()), schedules: true, ...deterministic() });
    const e = await failure(rt.invokeProcedure({ procedure: "audit", input: {}, caller: user("o1"), cause: { kind: "http", id: "c1" } }));
    expect(e.diagnostic).toMatchObject({ code: "OUTPUT_VALIDATION_FAILED", path: "manifest:Procedure/audit#/output" });
    expect(e.diagnostic.value).toBeUndefined();
  });
});
