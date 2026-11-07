import { describe, expect, it, vi } from "vitest";
import { reloadOnStaleChunk } from "./stale-chunk";

function fakeWindow(storage: Storage | null) {
  const target = new EventTarget(), reload = vi.fn();
  Object.defineProperty(target, "sessionStorage", { get() { if (!storage) throw new DOMException("denied", "SecurityError"); return storage; } });
  Object.defineProperty(target, "location", { value: { reload } });
  const win = target as unknown as Window;
  return { win, reload, fire: () => { const event = new Event("vite:preloadError", { cancelable: true }); target.dispatchEvent(event); return event; } };
}
const memory = (): Storage => { const map = new Map<string, string>(); return { getItem: k => map.get(k) ?? null, setItem: (k, v) => void map.set(k, v), removeItem: k => void map.delete(k), clear: () => map.clear(), key: () => null, get length() { return map.size; } }; };

describe("reloadOnStaleChunk", () => {
  it("reloads once after a stale chunk, then lets a repeat failure surface", () => {
    let t = 1_000_000;
    const { win, reload, fire } = fakeWindow(memory());
    reloadOnStaleChunk(win, () => t);
    expect(fire().defaultPrevented).toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);
    t += 2_000;
    expect(fire().defaultPrevented).toBe(false);
    expect(reload).toHaveBeenCalledTimes(1);
    t += 60_000; // a later deploy: reload again
    fire();
    expect(reload).toHaveBeenCalledTimes(2);
  });
  it("does not reload when it cannot remember the reload", () => {
    const { win, reload, fire } = fakeWindow(null);
    reloadOnStaleChunk(win);
    expect(fire().defaultPrevented).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });
});
