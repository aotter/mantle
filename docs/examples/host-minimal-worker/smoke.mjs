import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { unstable_dev } from "wrangler";

const worker = await unstable_dev("src/index.ts", {
  config: "wrangler.jsonc", local: true, ip: "127.0.0.1", port: 0,
  inspectorPort: 0, persist: false,
  experimental: { disableExperimentalWarning: true },
});
try {
  const response = await worker.fetch("/api/views/published-notes");
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.deepEqual(body.data.rows, []);
  assert.equal((await worker.fetch("/")).status, 404, "No implicit visitor homepage");
  const auth = await worker.fetch("/mcp/staff");
  assert.equal(auth.status, 503, "Auth must fail closed until configured");
  const pkg = JSON.parse(readFileSync("node_modules/@aotter/mantle/package.json", "utf8"));
  console.log(`Mantle ${pkg.version}: public View 200, home 404, unconfigured auth 503`);
} finally {
  await worker.stop();
}
