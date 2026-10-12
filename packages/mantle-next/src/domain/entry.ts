/**
 * Stable, injective build-only export names retained for generated consumers: every byte outside [A-Za-z0-9]
 * (including `$` and `_`) is `$` and two hex digits.
 * @internal
 */
export const exportName = (kind: string, name: string) => kind + "_" + name.replace(/[^A-Za-z0-9]+/g, run => Array.from(new TextEncoder().encode(run), b => "$" + b.toString(16).padStart(2, "0")).join(""));
