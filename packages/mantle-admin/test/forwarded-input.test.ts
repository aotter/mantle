import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { forwardedInput } from "../admin/src/mcp-app/forwarded-input";

beforeEach(() => void vi.useFakeTimers());
afterEach(() => void vi.useRealTimers());

it("calls wait for the tool input and repeat its forwarded arguments", async () => {
  const late = vi.fn();
  const forwarded = forwardedInput(["folder"], 5_000, late);
  forwarded.connected();
  const call = forwarded.args({ purpose: "cover" });
  forwarded.input({ folder: "docs", purpose: "cover", other: 1 });
  await expect(call).resolves.toEqual({ purpose: "cover", folder: "docs" });
  await vi.advanceTimersByTimeAsync(10_000);
  expect(late).not.toHaveBeenCalled();
});

it("after the timeout calls go without them; an input that arrives later is used and reported once", async () => {
  const late = vi.fn();
  const forwarded = forwardedInput(["folder"], 300, late);
  forwarded.connected();
  const early = forwarded.args({});
  await vi.advanceTimersByTimeAsync(300);
  await expect(early).resolves.toEqual({});
  forwarded.input({ folder: "docs" });
  expect(late).toHaveBeenCalledTimes(1);
  await expect(forwarded.args({ uploadId: "u" })).resolves.toEqual({ uploadId: "u", folder: "docs" });
  forwarded.input({ folder: "docs" });
  expect(late).toHaveBeenCalledTimes(1);
});

it("`false` waits until the input arrives; nothing forwarded never waits", async () => {
  const forwarded = forwardedInput(["folder"], false, () => {});
  forwarded.connected();
  let settled = false;
  const call = forwarded.args({}).then(args => ((settled = true), args));
  await vi.advanceTimersByTimeAsync(3_600_000);
  expect(settled).toBe(false);
  forwarded.input({ folder: "docs" });
  await expect(call).resolves.toEqual({ folder: "docs" });
  await expect(forwardedInput([], 300, () => {}).args({ a: 1 })).resolves.toEqual({ a: 1 });
});

it("mediaUploadCard refuses an inputTimeoutMs a timer cannot hold, at configuration", async () => {
  const { mediaUploadCard } = await import("../src/server/mcp");
  const card = (inputTimeoutMs: number | false) =>
    mediaUploadCard({
      media: () => ({ uploadOrigin: "https://media.example" }),
      forward: ["folder"],
      inputTimeoutMs,
    });
  for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 31])
    expect(() => card(bad)).toThrow("inputTimeoutMs");
  for (const good of [1, 5_000, 2 ** 31 - 1, false] as const) expect(() => card(good)).not.toThrow();
});
