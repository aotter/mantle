/** Offline size attribution and positive-selection experiment. No cloud writes. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { gzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { generateFromSources } from "../src/infrastructure/generate.js";

const base = resolve(import.meta.dir, "..");
const output = process.env.MANTLE_NEXT_FOOTPRINT_OUTPUT;
assert.ok(output, "set MANTLE_NEXT_FOOTPRINT_OUTPUT to a fresh local evidence directory");
await mkdir(output, { recursive: false });
await mkdir(resolve(output, "node_modules/@aotter"), { recursive: true });
await symlink(base, resolve(output, "node_modules/@aotter/mantle-next"), "dir");
for (const name of ["zod", "pg"]) await symlink(resolve(base, "node_modules", name), resolve(output, "node_modules", name), "dir");
const text = await readFile(resolve(base, "tests/apps/purchase.yaml"), "utf8");
const atoms = text.split(/^---\s*$/m).map(part => JSON.parse(part));
const selected = atoms.filter(atom => atom.kind === "Schema" || atom.metadata.name === "purchase-totals");
const report: { target: string; variant: string; uncompressedBytes: number }[] = [];
for (const target of ["cloudflare-d1", "cloudflare-postgres"] as const) {
  const postgres = target === "cloudflare-postgres";
  for (const variant of ["whole-before", "whole-after", "select-from-whole", "select-direct", "generate-selected", "native-selected", "driver-only", "select-10", "select-100", "direct-100"] as const) {
    const app = resolve(output, target, variant);
    await mkdir(app, { recursive: true });
    const count = variant === "select-10" ? 10 : variant === "select-100" || variant === "direct-100" ? 100 : 1;
    const manifest = variant === "generate-selected" || variant === "select-10" || variant === "select-100" || variant === "direct-100"
      ? [...selected.filter(atom => atom.kind === "Schema"), ...Array.from({length:count}, (_,index) => ({...selected.find(atom => atom.kind === "View"), metadata:{name:index === 0 ? "purchase-totals" : `purchase-totals-${index}`}}))].map(atom => JSON.stringify(atom)).join("\n---\n") : text;
    const generated = await generateFromSources({ target, sources: { sources: [{ sourceId: "purchase.yaml", text: manifest }] } });
    assert.ok(generated.ok, JSON.stringify(!generated.ok && generated.diagnostics));
    const code = generated.files["generated.ts"]!;
    for (const [name, content] of Object.entries(generated.files)) {
      await mkdir(dirname(resolve(app, name)), { recursive: true });
      await writeFile(resolve(app, name), content);
    }
    await writeFile(resolve(app, "generated.ts"), variant === "whole-before" ? code.replace('import * as z from "zod";', 'import { z } from "zod";') : code);
    // Independent native reference for this aggregate View, not the full API.
    // Same official Zod empty-object schema, user scope, literal SQL and result
    // shape. It imports no Mantle package. Full error parity is not asserted here.
    await writeFile(resolve(app, "native.ts"), `
import * as z from 'zod';
let schema;
export async function operation(db, caller, input) {
  if (caller.kind !== 'user') throw new Error('UNAUTHENTICATED');
  (schema ??= z.object({}).strict()).parse(input);
  const sql = ${JSON.stringify(`SELECT COUNT(*) AS "requestCount", SUM(amount) AS "totalAmount" FROM purchase_requests WHERE ownerid = ${postgres ? "$1" : "?1"}`)};
  ${postgres ? "const result = await db.query({text:sql,values:[caller.subject],types:{getTypeParser:()=>value=>value}}); return result.rows.map(row=>({requestCount:row.requestCount == null ? null : Number.isSafeInteger(Number(row.requestCount)) ? Number(row.requestCount) : row.requestCount,totalAmount:row.totalAmount == null ? null : Number(row.totalAmount)}));" : "return (await db.prepare(sql).bind(caller.subject).all()).results;"}
}
`);
    const whole = variant.startsWith("whole-");
    const native = variant === "native-selected";
    const driver = variant === "driver-only";
    const direct = variant === "select-direct" || variant === "direct-100";
    await writeFile(resolve(app, "worker.ts"), `
${driver ? "" : native ? "import { operation } from './native.ts';" : direct ? "import operation from './views/purchase-totals.js';" : `import { views${whole ? ", procedures" : ""} } from './generated.ts';`}
${postgres ? "import { Client } from 'pg';" : ""}
export default { async fetch(request, env) {
  const path = new URL(request.url).pathname;
  if (path === '/health') return new Response('ready');
  ${driver ? "" : `if(path === '/contract') {
    const db = ${postgres ? "{query:async()=>({rows:[{requestCount:'2',totalAmount:'15.5'}],fields:[{dataTypeID:20,dataTypeModifier:-1},{dataTypeID:701,dataTypeModifier:-1}]})}" : "{prepare:()=>({bind:()=>({all:async()=>({results:[{requestCount:2,totalAmount:15.5}]})})})}"};
    return Response.json(await ${native || direct ? "operation" : "views['purchase-totals']"}(db,{kind:'user',subject:'fixture',role:null,scopes:[],credential:'session',credentialId:null,clientId:null},{}));
  }`}
  ${whole ? "const [kind,name]=path.slice(1).split('/'); const operation=(kind==='views'?views:procedures)[name]; if(!operation)return new Response('Unknown operation',{status:404});" : "if(path !== '/run')return new Response('Unknown operation',{status:404});"}
  const db = ${postgres ? "new Client({connectionString:env.HYPERDRIVE.connectionString})" : "env.DB"};
  try {
    ${postgres ? "await db.connect();" : ""}
    ${driver ? `return Response.json(${postgres ? "(await db.query('SELECT 1')).rows" : "(await db.prepare('SELECT 1').all()).results"});` : `return Response.json(await ${whole || native || direct ? "operation" : "views['purchase-totals']"}(db,{kind:'user',subject:'fixture',role:null,scopes:[],credential:'session',credentialId:null,clientId:null},await request.json()));`}
  } finally { ${postgres ? "await db.end();" : ""} }
} };
`);
    await writeFile(resolve(app, "wrangler.json"), JSON.stringify({ name: "mantle-next-footprint-local", main: "worker.ts", compatibility_date: "2026-09-28", compatibility_flags: ["nodejs_compat"] }));
    execFileSync("node", [resolve(base, "node_modules/wrangler/bin/wrangler.js"), "deploy", "--dry-run", "--minify", "--config", resolve(app, "wrangler.json"), "--metafile", resolve(app, "meta.json"), "--outdir", resolve(app, "bundle")], {cwd:base,env:{...process.env,WRANGLER_SEND_METRICS:"false"},stdio:"pipe"});
    const modules = (await readdir(resolve(app, "bundle"))).filter(name => name !== "README.md" && !name.endsWith(".map"));
    assert.deepEqual(modules, ["worker.js"]);
    const bytes = await readFile(resolve(app, "bundle/worker.js"));
    const meta = JSON.parse(await readFile(resolve(app, "meta.json"), "utf8"));
    const groups: Record<string, number> = {};
    for (const [file, result] of Object.entries(meta.outputs) as [string, any][]) {
      if (!file.endsWith(".js")) continue;
      for (const [name, contribution] of Object.entries(result.inputs) as [string, any][]) {
        const group = /\/zod\//.test(name) ? /\/locales\//.test(name) ? "zod-locales" : "zod" : name.includes("kernel/contracts") ? "contracts" : name.endsWith("generated.ts") ? "generated" : name.endsWith("native.ts") ? "native" : "driver-and-entry";
        groups[group] = (groups[group] ?? 0) + contribution.bytesInOutput;
      }
    }
    const row = { target, variant, uncompressedBytes:bytes.length, gzipBytes:gzipSync(bytes).length, sha256:createHash("sha256").update(bytes).digest("hex"), contributions:groups };
    report.push(row); console.log(JSON.stringify(row));
  }
}
await writeFile(resolve(output, "sizes.json"), JSON.stringify(report, null, 2));
for (const target of ["cloudflare-d1", "cloudflare-postgres"]) {
  const rows = report.filter(row => row.target === target);
  const direct = rows.find(row => row.variant === "select-direct")!.uncompressedBytes;
  assert.ok(direct <= (target === "cloudflare-d1" ? 80 * 1024 : 176 * 1024), "selected entry grew beyond baseline budget");
  assert.ok(direct <= rows.find(row => row.variant === "native-selected")!.uncompressedBytes + 4096, "aggregate View exceeds the native reference by 4 KiB");
  assert.ok(rows.find(row => row.variant === "direct-100")!.uncompressedBytes <= direct + 128, "unselected Views enter the direct operation bundle");
}
