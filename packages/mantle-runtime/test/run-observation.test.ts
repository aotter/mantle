import { expect, it } from "vitest";
import { CANONICAL_MIGRATIONS } from "../src/infrastructure/boot/canonicalMigrations.js";
import { DatabaseRunObservationStore } from "../src/infrastructure/persistence/DatabaseRunObservationStore.js";
import { InMemoryDatabase } from "./fakes/database.js";

it("records retry attempts under one run id and bounds durable history", async () => {
  const db = new InMemoryDatabase();
  await db.migrations.runAll(CANONICAL_MIGRATIONS);
  let now = 1_700_000_000_000;
  const store = new DatabaseRunObservationStore(db, () => now);
  const input = { scheduleId: "daily", runId: "daily:1700000000000", scheduledAt: now, startedAt: now };
  expect(await store.start(input)).toBe(1);
  expect((await store.recent(10))[0]).toMatchObject({ status: "started", finishedAt: null, durationMs: null });
  await store.finish({ runId: input.runId, attempt: 1, finishedAt: now + 12,
    status: "failed", errorSummary: "HANDLER_ERROR", counts: null });
  expect(await store.start({ ...input, startedAt: now + 20 })).toBe(2);
  await store.finish({ runId: input.runId, attempt: 2, finishedAt: now + 30,
    status: "succeeded", errorSummary: null, counts: { scanned: 4, removed: 4 } });
  expect(await store.recent(10)).toEqual([
    expect.objectContaining({ attempt: 2, status: "succeeded", durationMs: 10, counts: { scanned: 4, removed: 4 } }),
    expect.objectContaining({ attempt: 1, status: "failed", durationMs: 12, errorSummary: "HANDLER_ERROR" }),
  ]);
  expect(await store.latestBySchedule()).toEqual([
    expect.objectContaining({ scheduleId: "daily", attempt: 2 }),
  ]);
  const weekly = { scheduleId: "weekly", runId: "weekly:1700000000000", scheduledAt: now, startedAt: now + 1 };
  expect(await store.start(weekly)).toBe(1);
  for (let i = 0; i < 31; i++) {
    await store.start({ scheduleId: "daily", runId: `daily:${i}`, scheduledAt: now, startedAt: now + 100 + i });
  }
  expect((await store.recent(30)).every((run) => run.scheduleId === "daily")).toBe(true);
  expect(await store.latestBySchedule()).toEqual([
    expect.objectContaining({ scheduleId: "daily" }),
    expect.objectContaining({ scheduleId: "weekly" }),
  ]);
  await expect(store.recent(51)).rejects.toThrow("1–50");
  now += 31 * 86_400_000;
  expect(await store.recent(10)).toEqual([]);
  expect(await store.latestBySchedule()).toEqual([]);
  expect(await store.start({ ...input, runId: "daily:new", scheduledAt: now, startedAt: now })).toBe(1);
  expect((await db.prepare("SELECT count(*) AS count FROM _mantle_schedule_runs").first<{ count: number }>())?.count).toBe(1);
});
