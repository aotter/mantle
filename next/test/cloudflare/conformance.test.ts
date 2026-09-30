import { expect, it } from "vitest";
import { LocalD1 } from "../../src/cloudflare/testing/d1.js";
import { runStorageConformance } from "../../src/testing/index.js";

it("the storage conformance suite passes on local D1", async () => {
  const report = await runStorageConformance({
    create: async () => {
      const d1 = await LocalD1.create();
      return { driver: d1, cleanup: () => d1.dispose() };
    },
  });
  expect(report.failures).toEqual([]);
  expect(report.checks.length).toBeGreaterThan(50);
}, 180_000);
