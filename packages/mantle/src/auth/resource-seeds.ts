/** Keep runtime inputs while disabling the provider's eager and bulk lazy seeding. No schema or database work. */
// OAuth provider 1.7.7 shares plugin.options with its eager/lazy seed closures; its seedResources/checkIdentifier helpers are not exported.
const seeds = new WeakMap<object, readonly unknown[]>();
export function resourceSeeds<T>(options: { resources?: T[] }): readonly T[] {
  const inputs = (seeds.get(options) ?? options.resources ?? []) as readonly T[];
  if (!seeds.has(options)) seeds.set(options, [...inputs]);
  options.resources = [];
  return inputs;
}
