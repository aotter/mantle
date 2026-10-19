/** Invoke only in a coordinated quiet slot: `bun run bench` (scripts/verify-native.ts --bench). Native SQL/rows remain same-driver. */
import assert from "node:assert/strict";

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
