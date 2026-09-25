import { describe, expect, it, vi } from "vitest";
import type { Diagnostic } from "@aotter/mantle-spec";
import {
  createInteractionController,
  type EntrySnapshot,
  type InteractionControllerOptions,
  type InvokeOutcome,
} from "../src/controller/index.js";

const review = { bind: [{ input: "id", field: "id" }], version: "expectedVersion" } as const;
const row = { id: "r1", version: 3, requestStatus: "submitted", note: "" };
const entry = (version: number, data: Record<string, unknown> = {}): EntrySnapshot =>
  ({ id: "r1", version, data: { ...row, version, ...data } });
const conflict: Diagnostic = { code: "CONFLICT", phase: "runtime", severity: "error", path: "MCP review", message: "Version moved." };
const denied: Diagnostic = { code: "AUTH_DENIED", phase: "runtime", severity: "error", path: "MCP review", message: "No." };

function controller(overrides: Partial<InteractionControllerOptions> = {}) {
  const read = vi.fn(async () => entry(3));
  const invoke = vi.fn(async (): Promise<InvokeOutcome> => ({ ok: true, data: { id: "r1", version: 4 } }));
  const created = createInteractionController({ interaction: review, row, read, invoke, ...overrides });
  return { controller: created, read, invoke };
}

describe("createInteractionController", () => {
  it("submits once with the row bindings and the reviewed version", async () => {
    const { controller: c, invoke } = controller();
    await c.open();
    expect(c.getSnapshot().phase).toBe("ready");
    c.edit("requestStatus", "approved");
    await c.submit();
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke.mock.calls[0]![0]).toEqual({ requestStatus: "approved", id: "r1", expectedVersion: 3 });
    expect(c.getSnapshot()).toMatchObject({ phase: "succeeded", result: { version: 4 }, dirty: false });
  });

  it("stops at changedSinceList when the target moved after the list was read", async () => {
    const { controller: c, invoke } = controller({ read: async () => entry(5, { requestStatus: "approved" }) });
    await c.open();
    expect(c.getSnapshot()).toMatchObject({ phase: "changedSinceList", reviewed: { version: 3 }, latest: { version: 5 } });
    // The version the person saw is never silently swapped for the new one.
    await c.submit();
    expect(invoke).not.toHaveBeenCalled();
    c.review();
    expect(c.getSnapshot()).toMatchObject({ phase: "ready", reviewed: { version: 5 }, latest: null });
    await c.submit();
    expect(invoke.mock.calls[0]![0]).toMatchObject({ expectedVersion: 5 });
  });

  it("keeps edits and the reviewed version through a background refresh", async () => {
    const read = vi.fn(async () => entry(3));
    const { controller: c, invoke } = controller({ read });
    await c.open();
    c.edit("note", "Within budget");
    read.mockResolvedValueOnce(entry(4, { note: "someone else" }));
    await c.refresh();
    expect(c.getSnapshot()).toMatchObject({
      phase: "changedSinceList",
      draft: { note: "Within budget" },
      reviewed: { version: 3 },
      latest: { version: 4 },
    });
    // The reviewed mutation is not moved onto the new version behind the person's back.
    await c.submit();
    expect(invoke).not.toHaveBeenCalled();
  });

  it("keeps the input on a conflict and requires a reread and a new review", async () => {
    const invoke = vi.fn(async (): Promise<InvokeOutcome> => ({ ok: false, diagnostics: [conflict] }));
    const read = vi.fn(async () => entry(3));
    const { controller: c } = controller({ invoke, read });
    await c.open();
    c.edit("requestStatus", "rejected");
    await c.submit();
    expect(c.getSnapshot()).toMatchObject({ phase: "conflict", diagnostics: [conflict], draft: { requestStatus: "rejected" } });
    await c.submit();
    expect(invoke).toHaveBeenCalledTimes(1);
    read.mockResolvedValueOnce(entry(4));
    await c.reread();
    expect(c.getSnapshot()).toMatchObject({ phase: "changedSinceList", latest: { version: 4 }, draft: { requestStatus: "rejected" } });
    c.review();
    invoke.mockResolvedValueOnce({ ok: true, data: {} });
    await c.submit();
    expect(invoke.mock.calls[1]![0]).toMatchObject({ requestStatus: "rejected", expectedVersion: 4 });
  });

  it("never retries a write whose outcome is unknown", async () => {
    const invoke = vi.fn(async (): Promise<InvokeOutcome> => { throw new Error("timeout"); });
    const read = vi.fn(async () => entry(3));
    const { controller: c } = controller({ invoke, read });
    await c.open();
    await c.submit();
    expect(c.getSnapshot()).toMatchObject({ phase: "uncertain", error: expect.any(Error) });
    await c.submit();
    expect(invoke).toHaveBeenCalledTimes(1);
    // The write landed: the reread shows the new version for review.
    read.mockResolvedValueOnce(entry(4));
    await c.reread();
    expect(c.getSnapshot()).toMatchObject({ phase: "changedSinceList", latest: { version: 4 } });
  });

  it("returns to ready after an uncertain write that did not land", async () => {
    const invoke = vi.fn(async (): Promise<InvokeOutcome> => { throw new Error("reset"); });
    const { controller: c } = controller({ invoke });
    await c.open();
    await c.submit();
    await c.reread();
    expect(c.getSnapshot()).toMatchObject({ phase: "ready", reviewed: { version: 3 } });
  });

  it("cancels a read, and marks a cancelled submit uncertain", async () => {
    let release!: (value: EntrySnapshot) => void;
    const { controller: c } = controller({ read: (signal) => new Promise((resolve) => {
      release = resolve;
      signal.addEventListener("abort", () => resolve(entry(9)));
    }) });
    const opening = c.open();
    c.cancel();
    release(entry(9));
    await opening;
    expect(c.getSnapshot()).toMatchObject({ phase: "cancelled", latest: null, reviewed: { version: 3 } });
    c.edit("note", "late");
    expect(c.getSnapshot().draft).toEqual({});

    const pending = controller({ invoke: (_input, signal) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    }) });
    await pending.controller.open();
    const submitting = pending.controller.submit();
    pending.controller.cancel();
    await submitting;
    expect(pending.controller.getSnapshot().phase).toBe("uncertain");
  });

  it("refuses edits to bound inputs and the version, and shows business refusals", async () => {
    const { controller: c } = controller({ invoke: async () => ({ ok: false, diagnostics: [denied] }) });
    await c.open();
    expect(() => c.edit("id", "other")).toThrow(/cannot be edited/u);
    expect(() => c.edit("expectedVersion", 9)).toThrow(/cannot be edited/u);
    c.edit("note", "x");
    await c.submit();
    expect(c.getSnapshot()).toMatchObject({ phase: "failed", diagnostics: [denied], draft: { note: "x" } });
  });

  it("does not submit against an unconfirmed version after a failed read", async () => {
    const { controller: c, invoke } = controller({ read: async () => { throw new Error("offline"); } });
    await c.open();
    expect(c.getSnapshot()).toMatchObject({ phase: "failed", error: expect.any(Error) });
    await c.submit();
    expect(invoke).not.toHaveBeenCalled();
  });

  it("opens without a read when the operation locks no version, and lists changes", async () => {
    const read = vi.fn();
    const c = createInteractionController({
      interaction: { bind: [{ input: "ticket", field: "ticketNumber" }] },
      row: { id: "t1", version: 1, ticketNumber: "T-1", subject: "Old" },
      read,
      invoke: async () => ({ ok: true, data: {} }),
    });
    await c.open();
    expect(read).not.toHaveBeenCalled();
    c.edit("subject", "New");
    c.edit("priority", "high");
    expect(c.changes()).toEqual([
      { field: "subject", before: "Old", after: "New" },
      { field: "priority", before: undefined, after: "high" },
    ]);
  });

  it("notifies subscribers with immutable snapshots", async () => {
    const { controller: c } = controller();
    const seen: string[] = [];
    const unsubscribe = c.subscribe(() => seen.push(c.getSnapshot().phase));
    const before = c.getSnapshot();
    await c.open();
    expect(Object.isFrozen(c.getSnapshot())).toBe(true);
    expect(c.getSnapshot()).not.toBe(before);
    unsubscribe();
    c.edit("note", "x");
    expect(seen).toEqual(["loading", "ready"]);
  });
});
