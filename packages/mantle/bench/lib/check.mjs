// Check rules. Deterministic facts (errors, row floors, parity, counters) are failures; timing is a warning unless strict.
// Pure: takes the measured results and the items' declared expectations, returns a list of checks.
import { GATED_KEYS } from "./counters.mjs";

/**
 * @param results    [{ item, error?, rows, parity: { record, native, mantle }, counters?: { first, warm, status }, warm?, cold? }]
 * @param items      the items (name, minRows, zeroWarm, zeroFirst)
 * @param thresholds { warm: { overheadUsMax, overheadRatioMax }, cold: { firstCallOverheadMsMax } }
 */
export function evaluate({ results, items, thresholds = {}, strictTiming = false }) {
  const byName = new Map(items.map((i) => [i.name, i]));
  const timing = strictTiming ? "fail" : "warn";
  const checks = [];
  const add = (item, rule, ok, level, detail) => checks.push({ item, rule, ok, level, detail });

  for (const r of results) {
    const item = byName.get(r.item);
    if (r.error) { add(r.item, "ran", false, "fail", r.error.split("\n")[0]); continue; }
    add(r.item, "ran", true, "fail", "");
    add(r.item, "minRows", r.rows >= item.minRows, "fail", `${r.rows} rows, at least ${item.minRows} expected`);
    if (r.parity?.record) {
      const same = (a) => a === undefined || JSON.stringify(a) === JSON.stringify(r.parity.record);
      add(r.item, "parity", same(r.parity.native) && same(r.parity.mantle), "fail", `statement row counts: recorded ${JSON.stringify(r.parity.record)}, native cold ${JSON.stringify(r.parity.native)}, Mantle cold ${JSON.stringify(r.parity.mantle)}`);
    }
    if (r.counters) {
      for (const key of GATED_KEYS) {
        const status = r.counters.status[key];
        const named = item.zeroWarm.includes(key) || item.zeroFirst.includes(key);
        // a renamed function is loud only where the item depends on it: an unrelated item must not go red
        if (status === "missing") add(r.item, `counter:${key}`, false, named ? "fail" : "warn", `${key} is loaded but its function is missing: update bench/lib/counters.mjs`);
      }
      for (const key of item.zeroWarm) add(r.item, `zeroWarm:${key}`, r.counters.warm[key] === 0, "fail", `${key} ran ${r.counters.warm[key]} times on a warm call, expected 0`);
      for (const key of item.zeroFirst) add(r.item, `zeroFirst:${key}`, r.counters.first[key] === 0, "fail", `${key} ran ${r.counters.first[key]} times on the first call, expected 0`);
    }
    const warm = r.warm?.summary;
    if (warm && thresholds.warm) {
      const limit = Math.max(thresholds.warm.overheadUsMax, thresholds.warm.overheadRatioMax * warm.nativeP50);
      add(r.item, "timing:warm", warm.overhangP50 <= limit, timing, `warm overhang ${warm.overhangP50.toFixed(0)} µs, limit ${limit.toFixed(0)} µs`);
    }
    if (r.cold && thresholds.cold) {
      add(r.item, "timing:cold", r.cold.overhang <= thresholds.cold.firstCallOverheadMsMax, timing, `cold overhang ${r.cold.overhang.toFixed(1)} ms, limit ${thresholds.cold.firstCallOverheadMsMax} ms`);
    }
  }
  return checks;
}

export const failures = (checks) => checks.filter((c) => !c.ok && c.level === "fail");
