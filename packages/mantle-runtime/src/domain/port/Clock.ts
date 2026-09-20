/**
 * `Clock` — abstracted time source. Use cases inject it instead of
 * calling `Date.now()` directly so tests can run with a fixed clock
 * and production stays on real time without ceremony.
 *
 * Defaults: `Date.now`. `createMantleRuntime` binds the default; tests override.
 */
export interface Clock {
  now(): number;
}

export const SystemClock: Clock = { now: () => Date.now() };
