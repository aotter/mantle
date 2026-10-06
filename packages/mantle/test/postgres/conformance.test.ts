// @ts-nocheck test code over loosely typed results
/** The dialect compliance suite (ADR-0035 decision 8) on PostgreSQL. */
import { expect, it } from "vitest";
import { runStorageConformance } from "../../src/testing/index.js";
import { pgDatabaseDriver, postgresStorage } from "../../src/postgres/index.js";
import * as pgCompile from "../../src/postgres/compile/index.js";
import { PG_URL, freshSchema } from "./engine.js";

it.skipIf(!PG_URL)("the PostgreSQL dialect passes the compliance suite", async () => {
  const report = await runStorageConformance({
    compile: pgCompile,
    create: async () => {
      const { connect, drop } = await freshSchema();
      return { storage: postgresStorage({ connect }), driver: pgDatabaseDriver(connect), cleanup: drop };
    },
  });
  expect(report.failures).toEqual([]);
  expect(report.ok).toBe(true);
}, 300_000);
