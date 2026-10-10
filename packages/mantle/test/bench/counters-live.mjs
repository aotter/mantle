// Helper process for counters.test.ts: start coverage, import the built d1 printer, print one IR, report the counts.
import { pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { startCoverage } from "../../bench/lib/counters.mjs";

const printFile = process.argv[2];
const mantleDir = join(dirname(printFile), "../..");
const coverage = await startCoverage(pathToFileURL(mantleDir).href);
const { print } = await import(pathToFileURL(printFile).href);
await coverage.take();
print({ SelectStmt: { targetList: [{ ResTarget: { val: { A_Const: { ival: { ival: 1 } } } } }], limitOption: "LIMIT_OPTION_DEFAULT", op: "SETOP_NONE" } });
const result = await coverage.take();
await coverage.stop();
console.log(JSON.stringify(result));
