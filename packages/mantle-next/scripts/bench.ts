/** Invoke the CLI only in a coordinated quiet slot. Native SQL/rows remain same-driver. */
import assert from "node:assert/strict";

export async function pairedReadBenchmark(generated: () => Promise<unknown>, native: () => Promise<unknown>) {
  assert.deepEqual(await generated(), await native(), "benchmark requires semantic equality");
  for (let i = 0; i < 20; i++) { await generated(); await native(); }
  const samples: { round: number; variant: "generated" | "native"; sample: number; microseconds: number }[] = [];
  for (let round = 1; round <= 3; round++) {
    for (let sample = 0; sample < 200; sample++) {
      const order = (sample + round) % 2 ? ["generated", "native"] as const : ["native", "generated"] as const;
      for (const variant of order) {
        const start = performance.now(); await (variant === "generated" ? generated : native)();
        samples.push({ round, variant, sample, microseconds: (performance.now() - start) * 1000 });
      }
    }
  }
  const summary = ["generated", "native"].map(variant => {
    const values = samples.filter(row => row.variant === variant).map(row => row.microseconds).sort((a, b) => a - b);
    return { variant, samples: values.length, p50Microseconds: values[Math.ceil(values.length * .5) - 1], p95Microseconds: values[Math.ceil(values.length * .95) - 1] };
  });
  return { scope: "same-driver local read; native includes equivalent row projection; exploratory paired samples", summary, samples };
}

if (import.meta.main) {
  assert.equal(process.env.MANTLE_NEXT_QUIET_SLOT, "1", "Set MANTLE_NEXT_QUIET_SLOT=1 only after coordinated quiet grant");
  const target = process.argv[2];
  const child = Bun.spawn([process.execPath, `${import.meta.dir}/verify-native.ts`, ...(target ? [target] : []), "--bench"], { env: process.env, stdout: "inherit", stderr: "inherit" });
  process.exitCode = await child.exited;
}
