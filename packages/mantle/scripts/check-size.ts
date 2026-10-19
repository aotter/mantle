/** Offline deployment bundles (`mantle bundle`): the whole purchase API, including postgres.js; startup graph and total upload. */
import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
      // A direct operation import carries only that operation.
      const entry = resolve(app, "direct-op.ts");
      await writeFile(entry, 'export { default } from "./views/purchase-list.js";');
      const meta = await bundle(entry, resolve(app, "direct-op-bundle"));
      const bytes = startupGraph(meta, entry).reduce((total, file) => total + meta.outputs[file]!.bytes, 0);
      assert.ok(bytes < 4 * 1024, `direct-op startup exceeds 4 KiB: ${bytes}`);
      console.log(JSON.stringify({ target, entry: "direct-op", startupBytes: bytes }));
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
    // The deployment build `mantle generate` configures: split ESM, operations as lazily imported chunks.
    const entry = resolve(app, "worker.ts"), meta = await bundle(entry, resolve(app, "bundle"));
    const inputs = Object.values(meta.outputs).flatMap(output => Object.keys(output.inputs));
    assert.ok(!inputs.some(input => /(?:^|\/)(?:src|dist)\/(?:build|core|spec)\//.test(input)), "old compiler/runtime in Worker bundle");
    assert.ok(!inputs.some(input => /\/zod\//.test(input)), "a validator entered the bare query bundle");
    const sum = (files: string[]) => files.reduce((total, file) => total + meta.outputs[file]!.bytes, 0);
    const js = Object.keys(meta.outputs).filter(file => file.endsWith(".js"));
    const report = { target, startupBytes: sum(startupGraph(meta, entry)), totalBytes: sum(js), gzipBytes: (await Promise.all(js.map(file => readFile(resolve(base, file))))).reduce((n, b) => n + gzipSync(b).length, 0), budgetBytes: budgets[target] };
    console.log(JSON.stringify(report));
    if (process.env.MANTLE_NEXT_SIZE_OUTPUT) await cp(app, resolve(process.env.MANTLE_NEXT_SIZE_OUTPUT, target), { recursive: true, errorOnExist: true, force: false });
    if (report.totalBytes > budgets[target]) console.warn(`[size report] ${target}: ${report.totalBytes} exceeds the reference ${budgets[target]}`);
  }
  // Startup of a Worker mounting each surface (the MCP SDK stays a request-time chunk): the runtime a deployment loads.
  const app = resolve(directory, "surfaces");
  await writeGenerated(app, await generateOrThrow("cloudflare-d1", await loadFixtureSources("surfaces.yaml")), false);
  const caller = 'caller:async()=>({kind:"anonymous"} as const)';
  const site = 'web({db:env.DB,caller:{kind:"anonymous"},origin:"https://example.test",title:"T",description:"D",pages:{"/items/{title}":{view:"item-by-title",list:"items",markdown:"body"}}}).fetch(request)';
  const surfaces = {
    rest: `import {rest} from "./rest.js"; const api=rest({db:(env:any)=>env.DB,${caller}}); export default {fetch:(request:Request,env:any)=>api(request,env)};`,
    mcp: `import {mcp} from "./mcp.js"; const tools=mcp({db:(env:any)=>env.DB,${caller}}); export default {fetch:(request:Request,env:any)=>tools(request,env)};`,
    web: `import {web} from "./web.js"; export default {fetch:(request:Request,env:any)=>${site}};`,
    all: `import {rest} from "./rest.js"; import {mcp} from "./mcp.js"; import {web} from "./web.js"; const api=rest({db:(env:any)=>env.DB,${caller}}),tools=mcp({db:(env:any)=>env.DB,${caller}}); export default {fetch:async(request:Request,env:any)=>(await api(request,env))??(await tools(request,env))??${site}};`,
  };
  for (const [surface, code] of Object.entries(surfaces)) {
    const entry = resolve(app, `${surface}-worker.ts`);
    await writeFile(entry, code);
    const meta = await bundle(entry, resolve(app, `${surface}-bundle`));
    const startupBytes = startupGraph(meta, entry).reduce((total, file) => total + meta.outputs[file]!.bytes, 0), budget = budgets[`startup:${surface}`];
    console.log(JSON.stringify({ surface, startupBytes, budgetBytes: budget }));
    assert.ok(startupBytes <= budget, `${surface} Worker startup exceeds ${budget} bytes; slim the runtime before changing the budget`);
  }
} finally { await rm(directory, { recursive: true, force: true }); }
