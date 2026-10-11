// The fixture's config: the same shape an external app hands `--app` (see bench/README.md).
import { NOW, SEED_VERSION, fixture, rows } from "./seed.mjs";

export default {
  name: "training",
  manifests: "./manifests",
  handlers: "./handlers.mjs#handlers",
  seed: "./seed.mjs",
  seedVersion: SEED_VERSION,
  now: NOW,
  fixture,
  // `callers` are verbatim Caller values (src/core/caller.ts): a user needs every field, `role` included
  callers: {
    member: { kind: "user", subject: "m1", role: null, scopes: [], credential: "session", credentialId: null, clientId: null },
    noise: { kind: "user", subject: "o2", role: null, scopes: [], credential: "session", credentialId: null, clientId: null },
  },
  items: "./items.mjs",
  // Generous on purpose and warn-only unless --strict-timing. Set from the develop ba247760 run in
  // docs/benchmarks/runtime-overhang-baseline.md: the largest warm overhang was 1.6 ms and the largest cold overhang 54 ms, so
  // x3 rounded up gives 5 ms and 300 ms (never tighter than 2 ms or ratio 5, nor 300 ms: shared machines are noisy).
  thresholds: { warm: { overheadUsMax: 5000, overheadRatioMax: 5 }, cold: { firstCallOverheadMsMax: 300 } },
  describe: () => { const r = rows(); return { exercises: r.exercises.length, workouts: r.workouts.length, sets: r.sets.length }; },
};
