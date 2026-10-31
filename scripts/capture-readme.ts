/** Real English README screenshots from the official Purchasing example. Local fixtures only; never deploy. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { chromium } from "../packages/mantle-admin/node_modules/playwright/index.mjs";

const root = resolve(import.meta.dirname, ".."), directory = await mkdtemp(join(tmpdir(), "mantle-readme-"));
const output = resolve(root, "docs/assets/readme"), cli = resolve(root, "packages/mantle/dist/infrastructure/cli.js");
const execute = promisify(execFile), previousCwd = process.cwd();
let app: { stop(): Promise<void>; signIn(email:string):Promise<string>; owner:string; origin:string; call:Function; sql:Function } | undefined;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
let orders = 0;
// Same external-service boundary as the example's smoke: real approval logic, a local supplier and console email.
const supplier = createServer(async (request,response) => {
  for await (const _ of request) { /* drain the request */ }
  response.writeHead(200,{"content-type":"application/json"}).end(JSON.stringify({orderId:`SUP-${++orders}`}));
});
try {
  await execute(process.execPath,[cli,"init",directory]);
  await cp(join(root,"docs/examples/purchasing"),directory,{recursive:true});
  // Pack the current build so the app and SDK resolve one peer-dependency tree.
  const tarballs=join(directory,".sdk");await mkdir(tarballs);
  const manifest=JSON.parse(await readFile(join(directory,"package.json"),"utf8"));
  for(const name of ["mantle","mantle-admin","mantle-ui"]){
    const source=join(root,"packages",name);
    const version=JSON.parse(await readFile(join(source,"package.json"),"utf8")).version;
    await execute("pnpm",["pack","--pack-destination",tarballs],{cwd:source,maxBuffer:4*1024*1024});
    manifest.dependencies[`@aotter/${name}`]=`file:${relative(directory,join(tarballs,`aotter-${name}-${version}.tgz`))}`;
  }
  await writeFile(join(directory,"package.json"),JSON.stringify(manifest,null,2));
  await execute("pnpm",["install","--ignore-scripts"],{cwd:directory,maxBuffer:4*1024*1024});
  const appCli=join(directory,"node_modules/@aotter/mantle/dist/infrastructure/cli.js");
  await execute(process.execPath,[appCli,"generate","cloudflare-d1","generated","manifests/purchasing.yaml","--auth","src/auth.ts","--entry","src/index.ts","--admin"],{cwd:directory});
  for(const check of ["types","check","test"])await execute("pnpm",[check],{cwd:directory,maxBuffer:4*1024*1024});
  console.log("Purchasing types, generated-source check, typecheck and Admin MCP App test passed");
  await execute(process.execPath,["smoke.mjs"],{cwd:directory,maxBuffer:4*1024*1024});
  console.log("Official Purchasing smoke passed, including both MCP surfaces");
  await new Promise<void>(done=>supplier.listen(0,"127.0.0.1",done));
  const supplierUrl=`http://127.0.0.1:${(supplier.address() as {port:number}).port}`;
  process.chdir(directory);
  const {startApp}=await import(pathToFileURL(join(directory,"smoke-kit.mjs")).href);
  app=await startApp({vars:{EMPLOYEE_DOMAIN:"example.test",SUPPLIER_API_URL:supplierUrl,SUPPLIER_WEBHOOK_SECRET:"local-readme-test-only"}});
  const admin=await app!.signIn(app!.owner), employee=await app!.signIn("employee@example.test");
  const submit=async(title:string,amount:number,department:string)=>{
    const response=await app!.call("POST","/api/requests",{cookie:employee,body:{title,amount,department}});
    assert.equal(response.status,200,JSON.stringify(response.body));return response.body.results[0][0];
  };
  const review=await submit("Engineering laptops",2400,"Engineering");
  const approved=await submit("Design software licenses",680,"Design");
  const rejected=await submit("Office espresso machine",750,"Engineering");
  await submit("Team onboarding equipment",1100,"Engineering");
  await submit("Research display monitors",450,"Design");
  await submit("Workshop stationery",45,"Design");
  const overBudget=await submit("Server refresh proposal",12000,"Engineering");
  const operation=(name:string,body:unknown)=>app!.call("POST",`/admin/api/operations/${name}`,{cookie:admin,body});
  assert.equal((await operation("approve-request",{id:approved.id,expectedVersion:approved.version})).status,200);
  assert.equal((await operation("reject-request",{id:rejected.id,expectedVersion:rejected.version})).status,200);
  const before=await app!.sql("SELECT remaining FROM budgets WHERE department='Engineering'");
  assert.equal((await operation("approve-request",{id:overBudget.id,expectedVersion:overBudget.version})).status,409);
  assert.deepEqual(await app!.sql("SELECT remaining FROM budgets WHERE department='Engineering'"),before);
  assert.equal(orders,1);
  console.log("Verified real approval, supplier order, rejection and over-budget rollback");
  browser=await chromium.launch({headless:true,...(process.env.MANTLE_TEST_CHROMIUM?{executablePath:process.env.MANTLE_TEST_CHROMIUM}:{})});
  const page=await browser.newPage({viewport:{width:1600,height:820},deviceScaleFactor:1,locale:"en-US",colorScheme:"light",extraHTTPHeaders:{cookie:admin,origin:app!.origin}});
  page.setDefaultTimeout(20_000);
  await page.addInitScript(()=>{localStorage.setItem("cms.preference.language","en");localStorage.setItem("cms.preference.theme","light");});
  await mkdir(output,{recursive:true});
  const capture=async(name:string)=>{
    await page.evaluate(()=>document.fonts.ready);await page.waitForTimeout(800);
    assert.ok(!/[\u3400-\u9fff]/u.test(await page.locator("body").innerText()),`Non-English text in ${name}`);
    await page.screenshot({path:join(output,name),animations:"disabled"});console.log(`Captured ${name}`);
  };
  await page.goto(`${app!.origin}/admin/c/requests`);
  await page.getByText("Engineering laptops",{exact:true}).first().waitFor();
  await capture("admin-workspace.png");
  await page.goto(`${app!.origin}/admin/c/requests/${review.id}`);
  await page.getByRole("button",{name:"Approve a purchase request",exact:true}).waitFor();
  await capture("request-review.png");
  await page.setViewportSize({width:1600,height:1000});
  await page.goto(`${app!.origin}/admin/dev`);await page.locator(".react-flow__node").first().waitFor();
  await capture("system-wiring.png");
  await page.setViewportSize({width:1600,height:800});
  await page.goto(`${app!.origin}/admin/dev/overview/relationships`);await page.locator(".react-flow__node").first().waitFor();
  const edges=await page.locator(".react-flow__edge-path").evaluateAll(paths=>paths.map(path=>({start:path.getAttribute("marker-start"),end:path.getAttribute("marker-end")})));
  assert.equal(edges.length,3,"ER diagram must render all three declared references");
  assert.equal(edges.filter(edge=>edge.start?.includes("erd-many")).length,2,"Budgets must have two one-to-many relationships");
  assert.equal(edges.filter(edge=>edge.end?.includes("erd-one")).length,3);
  await capture("entity-relationships.png");
  await page.setViewportSize({width:1600,height:1060});
  await page.goto(`${app!.origin}/admin/dev/logic/procedures?selected=Procedure%3Aapprove-request-write`);await page.locator(".react-flow__node").first().waitFor();
  await capture("procedure-chart.png");
} finally {
  await browser?.close();await app?.stop();await new Promise<void>(done=>supplier.close(()=>done()));
  process.chdir(previousCwd);await rm(directory,{recursive:true,force:true});
}
