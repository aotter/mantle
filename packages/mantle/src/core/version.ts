/**
 * The `@aotter/mantle` version this Core was built from. `mantle generate` records it in `plan.lowered.mantle` (ADR-0044), and boot
 * uses lowered statements only from a plan lowered by the same version. Bump it with `package.json` (`test/core/version.test.ts` checks).
 */
export const MANTLE_VERSION = "0.2.0-alpha.6";
