/** Offline deployment bundles: the whole purchase API, including postgres.js. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { gzipSync } from "node:zlib";
import { bundle, startupGraph } from "../src/infrastructure/bundle.js";
import { generateOrThrow, loadFixtureSources, writeGenerated } from "../tests/apps/link.js";

const base = resolve(import.meta.dir, "..");
const directory = await mkdtemp(resolve(base, "tests/apps/.size-"));
const budgets = JSON.parse(await readFile(resolve(base, "size-budgets.json"), "utf8"));
const sources = await loadFixtureSources();
try {
  for (const target of ["cloudflare-d1", "cloudflare-postgres"] as const) {
    const app = resolve(directory, target);
    await writeGenerated(app, await generateOrThrow(target, sources), false); // the package (dist), as a deployment resolves it
    if (target === "cloudflare-d1") {
      for (const [name, source] of [
        ["collection", 'export { store } from "./generated.js";'],
        ["direct-op", 'export { default } from "./views/purchase-list.js";'],
      ]) {
        const entry = resolve(app, name + ".ts"), outdir = resolve(app, name + "-bundle");
        await writeFile(entry, source!);
        const meta = await bundle(entry, outdir), graph = startupGraph(meta, entry);
        assert.ok(graph.length > 0, "startup graph must include the entry");
        const code = (await Promise.all(graph.map(file => readFile(resolve(base, file), "utf8")))).join("\n");
        const bytes = graph.reduce((total, file) => total + meta.outputs[file]!.bytes, 0);
        if (name === "collection") {
          assert.ok(!/INSERT INTO purchase_requests|requestCount|submittedDay/.test(code), "operation SQL entered collection startup");
          assert.ok(!graph.some(file => Object.keys(meta.outputs[file]!.inputs).some(input => /\/(?:views|procedures)\//.test(input))), "operation module entered collection startup");
          assert.ok(Object.values(meta.outputs).some(output => Object.keys(output.inputs).some(input => input.endsWith("procedures/create-purchase.ts"))), "lazy operations must still be uploaded");
        } else {
          assert.ok(code.includes("FROM purchase_requests"), "direct operation SQL must be present");
          assert.ok(bytes < 4 * 1024, `direct-op startup exceeds 4 KiB: ${bytes}`);
        }
        console.log(JSON.stringify({ target, entry: name, startupBytes: bytes }));
      }
    }
    const postgres = target === "cloudflare-postgres";
    // No test oracle/seed/benchmark code in the deployment bundle. Caller is a
    // fixed fixture identity, not an example of production credential handling.
    await writeFile(resolve(app, "worker.ts"), `
import { views, procedures } from './generated.ts';
${postgres ? "import postgres from 'postgres';" : ""}
export default { async fetch(request, env) {
  const [kind, name] = new URL(request.url).pathname.slice(1).split('/');
  const operation = (kind === 'views' ? views : procedures)[name];
  if (!operation) return new Response('Unknown operation', {status:404});
  const db = ${postgres ? "postgres(env.HYPERDRIVE.connectionString)" : "env.DB"};
  try {
    return Response.json(await operation(db, {kind:'user',subject:'fixture',role:null,scopes:[],credential:'session',credentialId:null,clientId:null}, await request.json()));
  } finally { ${postgres ? "await db.end();" : ""} }
} };
`);
    await writeFile(resolve(app, "wrangler.json"), JSON.stringify({ name: "mantle-next-size-local", main: "worker.ts", compatibility_date: "2026-09-28", compatibility_flags: ["nodejs_compat"] }));
    execFileSync("node", [resolve(base, "node_modules/wrangler/bin/wrangler.js"), "deploy", "--dry-run", "--minify", "--metafile", resolve(app, "meta.json"), "--config", resolve(app, "wrangler.json"), "--outdir", resolve(app, "bundle")], {
      cwd: base, env: { ...process.env, WRANGLER_SEND_METRICS: "false" }, stdio: "pipe",
    });
    const names = await readdir(resolve(app, "bundle"));
    // This fixture must remain one JS module: don't silently omit future assets.
    const modules = names.filter(name => name !== "README.md" && !name.endsWith(".map"));
    assert.equal(modules.length, 1, `unexpected deployment modules: ${modules}`);
    assert.match(modules[0]!, /\.js$/);
    const bytes = await readFile(resolve(app, "bundle", modules[0]!));
    const map = JSON.parse(await readFile(resolve(app, "bundle", modules[0]! + ".map"), "utf8"));
    assert.ok(!map.sources.some((source: string) => /(?:^|\/)mantle\/(?:src|dist)\//.test(source) || /@aotter\/mantle(?:\/|$)/.test(source)), "old compiler/runtime in Worker bundle");
    assert.ok(!map.sources.some((source:string) => /\/zod\//.test(source)), "a validator entered the bare query bundle");
    const report = { target, uncompressedBytes: bytes.length, gzipBytes: gzipSync(bytes).length, budgetBytes: budgets[target] };
    console.log(JSON.stringify(report));
    if (process.env.MANTLE_NEXT_SIZE_OUTPUT) await cp(app, resolve(process.env.MANTLE_NEXT_SIZE_OUTPUT, target), { recursive: true, errorOnExist: true, force: false });
    assert.ok(bytes.length <= budgets[target], `${target} exceeds deployment bundle budget; inspect dependencies before changing the budget`);
  }
} finally { await rm(directory, { recursive: true, force: true }); }
