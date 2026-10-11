import { describe, expect, it } from "vitest";
import { registerGenerated, generatedFor, type GeneratedRuntime } from "../../src/core/runtime/generated.js";
import { MANTLE_VERSION } from "../../src/core/version.js";
import { d1Dialect as D1_DIALECT } from "../../src/d1/dialect.js";
import type { RuntimePlan } from "../../src/spec/domain/index.js";
import { createMantleRuntime } from "../../src/core/runtime/createRuntime.js";
import type { MantleStorageAdapter } from "../../src/core/service.js";
import { compile, handlers } from "./lowered-fixture.js";

describe("generated application registration", () => {
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
