import assert from 'node:assert/strict';
import { request } from 'playwright';
import { writeFile, rm } from 'node:fs/promises';
const name=process.argv[2], pairs=['bun-sqlite','bun-postgres','cf-sqlite','cf-postgres'];
assert(pairs.includes(name), 'Pass a known host/dialect pair');
const port=4421+pairs.indexOf(name), origin=`http://127.0.0.1:${port}`;
const api=await request.newContext({storageState:`evidence/${name}/.auth-owner.json`,extraHTTPHeaders:{origin}});
await rm(`evidence/${name}/extras.json`, { force: true });
const checks=[];
let buyer;
async function rpc(method,params={}) {
 const r=await api.post(origin+'/mcp/staff',{headers:{accept:'application/json, text/event-stream'},data:{jsonrpc:'2.0',id:1,method,params}});
 assert.equal(r.status(),200,await r.text());const text=await r.text(), line=text.split('\n').find(l=>l.startsWith('data:')); const body=JSON.parse(line?line.slice(5):text);assert(!body.error,JSON.stringify(body));return body.result;
}
try {
 const tools=await rpc('tools/list');assert(tools.tools.some(t=>t.name==='create_role'));checks.push('staff MCP discovers manifest tools');
 const role=await rpc('tools/call',{name:'create_role',arguments:{name:'MCP 矩陣驗收 '+Date.now(),request:true,approve:false,finance:false,purchase:false,receive:false}});assert(!role.isError,JSON.stringify(role));checks.push('real staff MCP procedure writes business role');
 const resource=await rpc('resources/list');assert(resource.resources.length);checks.push('MCP App resources available');
 const scoped=await api.get(origin+'/admin/api/entries?collection=child-items&scope_field=parentId&scope_value=request-000000&sort=position&direction=asc&limit=100');assert.equal(scoped.status(),200);assert.deepEqual((await scoped.json()).items.map(row=>row.data_preview.position),Array.from({length:100},(_,i)=>i));
 const filtered=await api.get(origin+'/admin/api/entries?collection=requests&filter_field=state&filter_value=approved&sort=amount&direction=asc&limit=100');assert.equal(filtered.status(),200);const ordered=(await filtered.json()).items;assert(ordered.length);assert(ordered.every((row,i)=>row.data_preview.state==='approved'&&(i===0||row.data_preview.amount>=ordered[i-1].data_preview.amount)));checks.push('scoped positions and indexed filtered amounts are actually ordered');
 const searched=await api.get(origin+'/admin/api/entries?collection=notes&search=Alpha');assert.equal(searched.status(),200);const matches=await searched.json();assert(matches.items.some(row=>row.title==='Alpha 管理後台真實操作公告'));checks.push('Chinese-title full-text search returns the saved announcement');
 const malformed=await api.post(origin+'/api/procedures/seed-local',{data:{collection:'budgets',rows:[{id:'invalid-budget',values:{department:'拒絕測試',remaining:-1,reserved:0}}]}});assert.equal(malformed.status(),400);checks.push('dynamic importer still enforces Schema validation');
 const settings=await api.get(origin+'/admin/api/site-settings');const body=await settings.json();assert.equal(settings.status(),501,JSON.stringify(body));checks.push('optional site settings explicitly answer 501 on unconfigured preset');
 buyer=await request.newContext({storageState:`evidence/${name}/.auth-buyer.json`,extraHTTPHeaders:{origin}});
 const created=await api.post(origin+'/api/procedures/create-request',{data:{title:'並行採購驗收 '+Date.now(),amountTwd:100,vendorId:'vendor-0',purpose:'八個並行請求只能有一個成功的版本驗收'}});assert.equal(created.status(),200);const createdBody=await created.json();const id=createdBody.results[0][0].id;
 const read=async()=> (await (await api.get(origin+`/admin/api/entries/${id}?collection=requests`)).json()).entry;
 let entry=await read();const submit=await api.post(origin+'/api/procedures/submit-request',{data:{id,expectedVersion:entry.version}});assert.equal(submit.status(),200);entry=await read();
 const statuses=await Promise.all(Array.from({length:8},async()=> (await buyer.post(origin+'/api/procedures/place-order',{data:{id,expectedVersion:entry.version}})).status()));
 assert.equal(statuses.filter(s=>s===200).length,1,JSON.stringify(statuses));assert.equal(statuses.filter(s=>s===409).length,7,JSON.stringify(statuses));checks.push('eight concurrent HTTP writers produce one commit and seven version conflicts');
 const csv=await api.get(origin+'/admin/api/entries/export?collection=child-items&scope_field=parentId&scope_value=request-000000&sort=position&direction=asc');assert.equal(csv.status(),200);const lines=(await csv.text()).trim().split('\n');assert.equal(lines.length,301);checks.push('scoped sorted CSV exports all 300 rows across pages');
 await writeFile(`evidence/${name}/extras.json`,JSON.stringify({passed:true,name,checks,optionalCapabilities:{siteSettings:'not configured',media:'not configured'}},null,2)); console.log(name,checks);
}finally{await api.dispose();await buyer?.dispose();}
