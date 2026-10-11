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
  return {
    scope: "same-driver local read; native includes equivalent row projection; exploratory paired samples",
    clockCaveat: "Bun performance.now measures elapsed function time. Worker performance.now advances with I/O events and can omit or misattribute post-I/O CPU; Worker samples are I/O-event intervals, not complete function latency. Use an external host clock for Worker performance acceptance.",
    summary, samples,
  };
}

if (import.meta.main) {
  assert.equal(process.env.MANTLE_NEXT_QUIET_SLOT, "1", "Set MANTLE_NEXT_QUIET_SLOT=1 only after coordinated quiet grant");
  const target = process.argv[2];
  const child = Bun.spawn([process.execPath, `${import.meta.dir}/verify-native.ts`, ...(target ? [target] : []), "--bench"], { env: process.env, stdout: "inherit", stderr: "inherit" });
  process.exitCode = await child.exited;
}


/** External HTTP batches; includes connection/transport cost, with native A/A. */
export async function externalReadBenchmark(url: string) {
  const variants = ["generated", "native-canonical", "native", "native-aa"] as const;
  const read = async (variant: typeof variants[number]) => {
    const start = process.hrtime.bigint();
    const response = await fetch(url + "/read-" + variant);
    const body = await response.json();
    const microseconds = Number(process.hrtime.bigint() - start) / 1000 / 20;
    assert.equal(response.status,200,JSON.stringify(body));
    return {body,microseconds};
  };
  const expected = (await read("native")).body;
  for (let warm=0;warm<10;warm++) for (const variant of variants) assert.deepEqual((await read(variant)).body,expected);
  const samples: {round:number;sample:number;variant:string;microseconds:number}[] = [];
  for (let round=0;round<3;round++) for (let sample=0;sample<30;sample++) {
    const offset=(sample+round)%variants.length;
    for (const variant of [...variants.slice(offset),...variants.slice(0,offset)]) {
      const measured=await read(variant);
      assert.deepEqual(measured.body,expected,"all external batches consume identical complete rows");
      samples.push({round,sample,variant,microseconds:measured.microseconds});
    }
  }
  const summary=variants.map(variant=>{
    const values=samples.filter(row=>row.variant===variant).map(row=>row.microseconds).sort((a,b)=>a-b);
    return {variant,samples:values.length,p50Microseconds:values[44],p95Microseconds:values[85]};
  });
  return {scope:"parent-clock HTTP elapsed / 20 sequential reads; includes connection, request and full final-row serialization; native A/A and exact generated-SQL control; 3 rounds x 30 batches",summary,samples};
}
