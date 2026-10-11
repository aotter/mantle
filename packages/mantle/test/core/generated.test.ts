import { afterEach, describe, expect, it, vi } from "vitest";
import { registerGenerated, generatedFor, type GeneratedRuntime } from "../../src/core/runtime/generated.js";
import { MANTLE_VERSION } from "../../src/core/version.js";
import { d1Dialect as D1_DIALECT } from "../../src/d1/dialect.js";
import type { RuntimePlan } from "../../src/spec/domain/index.js";
import { createMantleRuntime } from "../../src/core/runtime/createRuntime.js";
import type { MantleStorageAdapter } from "../../src/core/service.js";
import { compile, handlers } from "./lowered-fixture.js";
import { lowerReaderSeeds } from "../../src/core/store/readerSeeds.js";
import { sqliteStorage } from "../../src/d1/index.js";
import { nodeSqlite } from "../d1/node-sqlite.test.js";
import { StoreJson } from "../../src/core/store/json.js";

describe("generated application registration", () => {
  afterEach(() => vi.restoreAllMocks());
  const plan = () => ({ fingerprint: "sealed" }) as RuntimePlan;
  const artifact = (): GeneratedRuntime => ({ fingerprint: "sealed", mantle: MANTLE_VERSION,
    dialect: { name: D1_DIALECT.name, version: D1_DIALECT.version, key: D1_DIALECT.lowerKey ?? "" } });

  it("uses only the exact plan object, never a JSON copy", () => {
    const p = plan(), g = artifact();
    expect(generatedFor(p, D1_DIALECT)).toBeUndefined();
    registerGenerated(p, g);
    expect(generatedFor(p, D1_DIALECT)).toBe(g);
    expect(generatedFor({ ...p }, D1_DIALECT)).toBeUndefined();
  });

  it("adopts registered reader seeds through runtime boot, while an unregistered copy compiles normally", async () => {
    const p = await compile();
    const storage = sqliteStorage(nodeSqlite());
    const dialect = { ...storage.dialect, check: vi.fn(storage.dialect.check), print: vi.fn(storage.dialect.print) };
    registerGenerated(p, { ...artifact(), fingerprint: p.fingerprint, readerSeeds: lowerReaderSeeds(p.schemas, dialect) });
    const seeded = await createMantleRuntime({ plan: p, handlers, storage: { ...storage, dialect }, schedules: true });
    const read = vi.spyOn(StoreJson.prototype, "read");
    dialect.check.mockClear(); dialect.print.mockClear();
    expect(await seeded.store.db.items.first()).toBeNull();
    expect(dialect.check).not.toHaveBeenCalled();
    expect(dialect.print).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();

    const ordinary = await createMantleRuntime({ plan: structuredClone(p), handlers, storage: { ...storage, dialect }, schedules: true });
    dialect.check.mockClear(); dialect.print.mockClear();
    expect(await ordinary.store.db.items.first()).toBeNull();
    expect(dialect.check).toHaveBeenCalled();
    expect(read).toHaveBeenCalled();
  });

  it("disables code for uploaded, restricted, unsupported and incompatible runtimes", () => {
    const p = plan();
    registerGenerated(p, artifact());
    expect(generatedFor(p, D1_DIALECT, p.fingerprint)).toBeUndefined();
    expect(generatedFor(p, { ...D1_DIALECT, restricted: true })).toBeUndefined();
    expect(generatedFor(p, { ...D1_DIALECT, print: undefined })).toBeUndefined();
    for (const changed of [ { fingerprint: "other" }, { mantle: "other" },
      { dialect: { ...artifact().dialect, name: "other" } },
      { dialect: { ...artifact().dialect, version: "other" } },
      { dialect: { ...artifact().dialect, key: "other" } } ]) {
      registerGenerated(p, { ...artifact(), ...changed });
      expect(generatedFor(p, D1_DIALECT)).toBeUndefined();
    }
  });

  it("bundled code asserts an immutable plan, while uploaded and copied plans still detect mutation before storage", async () => {
    const p = await compile();
    registerGenerated(p, { ...artifact(), fingerprint: p.fingerprint });
    // This deliberately documents the accepted boundary: generated code does not detect post-generation content mutation.
    (p as unknown as Record<string, unknown>).changedAfterGeneration = true;
    const reachedStorage = new Error("reached storage");
    const storage = { dialect: D1_DIALECT, prepare: async () => { throw reachedStorage; } } as unknown as MantleStorageAdapter;
    await expect(createMantleRuntime({ plan: p, handlers, storage, schedules: true })).rejects.toBe(reachedStorage);
    for (const args of [ { plan: { ...p } }, { plan: p, expectedFingerprint: p.fingerprint },
      { plan: p, storage: { ...storage, dialect: { ...D1_DIALECT, restricted: true } } } ]) {
      await expect(createMantleRuntime({ plan: p, handlers, storage, schedules: true, ...args })).rejects.toMatchObject({
        diagnostic: { code: "PLAN_FINGERPRINT_MISMATCH" },
      });
    }
  });
});
