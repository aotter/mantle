/** Offline deployment bundles: the whole purchase API, including postgres.js. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { gzipSync } from "node:zlib";
import { generateFromSources } from "../src/infrastructure/generate.js";

const base = resolve(import.meta.dir, "..");
const directory = await mkdtemp(resolve(base, "tests/apps/.size-"));
const budgets = JSON.parse(await readFile(resolve(base, "size-budgets.json"), "utf8"));
const text = await readFile(resolve(base, "tests/apps/purchase.yaml"), "utf8");
try {
  for (const target of ["cloudflare-d1", "cloudflare-postgres"] as const) {
    const generated = await generateFromSources({ target, sources: { sources: [{ sourceId: "purchase.yaml", text }] } });
    assert.ok(generated.ok, JSON.stringify(!generated.ok && generated.diagnostics));
    const key = target;
    const app = resolve(directory, key);
    await mkdir(app);
    for (const [name, text] of Object.entries(generated.files)) {
      await mkdir(dirname(resolve(app, name)), { recursive: true });
      await writeFile(resolve(app, name), text);
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
    const report = { target, uncompressedBytes: bytes.length, gzipBytes: gzipSync(bytes).length, budgetBytes: budgets[key] };
    console.log(JSON.stringify(report));
    if (process.env.MANTLE_NEXT_SIZE_OUTPUT) await cp(app, resolve(process.env.MANTLE_NEXT_SIZE_OUTPUT, key), { recursive: true, errorOnExist: true, force: false });
    assert.ok(bytes.length <= budgets[key], `${target} exceeds deployment bundle budget; inspect dependencies before changing the budget`);
  }
} finally { await rm(directory, { recursive: true, force: true }); }
