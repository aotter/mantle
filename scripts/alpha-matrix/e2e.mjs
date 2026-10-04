import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, access, rm } from 'node:fs/promises';
import { chromium } from 'playwright';
const name = process.argv[2];
const pairs = ['bun-sqlite','bun-postgres','cf-sqlite','cf-postgres'];
const port = 4421 + pairs.indexOf(name);
assert(pairs.includes(name));
const origin = `http://127.0.0.1:${port}`;
const log = `/private/tmp/mantle-alpha-${name}.log`;
const output = `evidence/${name}`;
await mkdir(output, { recursive: true });
await rm(output+'/result.json', { force: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const checks = [], contexts = {};
let page;
const exists = async path => access(path).then(()=>true,()=>false);
const check = (label, detail = {}) => { checks.push({ label, ...detail }); console.log(name, label); };
async function code(email) {
  for(let i=0;i<100;i++) {
    const text = await readFile(log,'utf8');
    const start = text.lastIndexOf(`→ ${email} (`);
    const match = start >= 0 && /body:[^\n]*?(\d{6})/.exec(text.slice(start));
    if(match) return match[1];
    await new Promise(r=>setTimeout(r,100));
  }
  throw Error('OTP not logged for '+email);
}
async function api(who, path, body, expected=200, method=body===undefined?'GET':'POST', retry=0) {
  const response = await contexts[who].request.fetch(origin+path,{ method, ...(body===undefined?{}:{data:body}), headers:{origin} });
  if(response.status()===429 && expected!==429 && retry<3) {
    const wait=Math.min(61000,(Number(response.headers()['retry-after']??response.headers()['x-retry-after']??60)||60)*1000+200);
    console.log(name,'respect auth rate limit',wait); await new Promise(r=>setTimeout(r,wait));
    return api(who,path,body,expected,method,retry+1);
  }
  const text = await response.text();
  assert.equal(response.status(),expected, `${who} ${path}: ${text.slice(0,1200)}`);
  return text ? JSON.parse(text) : null;
}
const proc=(who,procedure,input,status=200)=>api(who,`/api/procedures/${procedure}`,input,status);
const row=async(collection,id)=>(await api('owner',`/admin/api/entries/${id}?collection=${collection}`)).entry;
async function seed(collection,rows) {
  for(let i=0;i<rows.length;i+=100) await proc('owner','seed-local',{collection,rows:rows.slice(i,i+100)});
  check(`seed ${collection}`,{rows:rows.length});
}
try {
 const owner=contexts.owner=await browser.newContext({viewport:{width:1440,height:1000}});
 await owner.addInitScript(()=>localStorage.setItem('cms.preference.language','en'));
 page=await owner.newPage();page.setDefaultTimeout(15000);
 const errors=[]; page.on('pageerror',e=>errors.push(e.message));
 await page.goto(origin+'/admin/sign-in');
 await page.locator('input[type=email]').fill('owner@alpha.test');
 await page.getByRole('button',{name:/Send.*code/i}).click();
 const otp=await code('owner@alpha.test');
 await page.locator('input[autocomplete="one-time-code"]').fill(otp);
 await page.waitForURL(url=>!url.pathname.includes('sign-in'));
 const me=await api('owner','/admin/api/me');assert.equal(me.role,'owner');
 await owner.storageState({path:output+'/.auth-owner.json'});
 const ownerId=(await api('owner','/api/auth/get-session')).user.id;
 check('real browser OTP bootstrap owner');
 await page.screenshot({path:output+'/01-signed-in.png',fullPage:true});
 const users={owner:ownerId};
 for(const who of ['requester','manager','finance','buyer','receiver','outsider']) {
  const state=`${output}/.auth-${who}.json`;
  const cached=await exists(state);
  const context=contexts[who]=await browser.newContext(cached?{storageState:state}:{});const email=`${who}@alpha.test`;
  if(!cached) { await api(who,'/api/auth/email-otp/send-verification-otp',{email,type:'sign-in'});
    await api(who,'/api/auth/sign-in/email-otp',{email,otp:await code(email)}); await context.storageState({path:state}); }
  const login=await api(who,'/api/auth/get-session'); users[who]=login.user.id;
  if(who!=='outsider')await api('owner',`/admin/api/staff/${login.user.id}/role`,{role:'contributor'},200,'PATCH');
 }
 check('real sessions and staff role assignment');
 const flags={owner:[true,true,true,true,true],requester:[true,false,false,false,false],manager:[true,true,false,false,false],finance:[false,false,true,false,false],buyer:[false,false,false,true,false],receiver:[false,false,false,false,true]};
 await seed('roles',Object.entries(flags).map(([who,v])=>({id:`role-${who}`,values:{name:`自訂角色 ${who}`,...Object.fromEntries(['request','approve','finance','purchase','receive'].map((f,i)=>[f,v[i]]))}})));
 await seed('memberships',Object.keys(flags).map(who=>({id:`member-${who}`,values:{subject:users[who],displayName:`內控測試 ${who}`,department:'研發部',roleId:`role-${who}`}})));
 await seed('budgets',[{id:'budget-rd',values:{department:'研發部',remaining:100000000,reserved:0}}]);
 await seed('vendors',Array.from({length:500},(_,i)=>({id:`vendor-${i}`,values:{name:`模擬供應商 ${String(i).padStart(4,'0')}`,active:i!==1,bankVerified:i!==1}})));
 const states=['draft','manager_review','finance_review','approved','ordered','received','paid'];
 await seed('requests',Array.from({length:20000},(_,i)=>({id:`request-${String(i).padStart(6,'0')}`,values:{title:`模擬請購 ${String(i).padStart(6,'0')} 工作站設備`,amount:10000+(i*7919)%20000000,currency:'TWD',department:i%2?'業務部':'研發部',requester:users.requester,vendorId:`vendor-${i%500}`,state:states[i%states.length],manager:'',financeApprover:'',purchaser:'',receiver:'',invoiceAmount:0,purpose:'大量模擬資料，用於 alpha 本地驗收'}})));
 await seed('child-items',Array.from({length:300},(_,i)=>({id:`child-${i}`,values:{parentId:'request-000000',title:`明細 ${i}`,position:i}})));
 const first=await api('owner','/admin/api/entries?collection=requests&limit=100'); assert.equal(first.items.length,100);assert(first.next_cursor);
 const second=await api('owner',`/admin/api/entries?collection=requests&limit=100&cursor=${encodeURIComponent(first.next_cursor)}`);
 assert.equal(second.items.length,100);assert(!second.items.some(x=>first.items.some(y=>x.id===y.id)));
 check('cursor pagination has no duplicates on 20k rows');
 const scoped=await api('owner','/admin/api/entries?collection=child-items&scope_field=parentId&scope_value=request-000000&sort=position&direction=asc&limit=100');
 assert.equal(scoped.items.length,100);check('relationship scope and compound-index sorting');
 const filtered=await api('owner','/admin/api/entries?collection=requests&filter_field=state&filter_value=approved&sort=amount&direction=asc&limit=100');
 assert(filtered.items.length);check('indexed enum filter and amount sorting');
 await api('outsider','/admin/api/bootstrap',undefined,403); await api('outsider','/api/procedures/seed-local',{collection:'roles',rows:[]},403);check('unauthorized Admin and importer denied');
 await proc('requester','create-request',{title:'無效金額',amountTwd:0,vendorId:'vendor-0',purpose:'測試輸入拒絕'},400);check('procedure input validation');
 const create=async(title,amountTwd,who='requester',vendorId='vendor-0')=>{const r=await proc(who,'create-request',{title,amountTwd,vendorId,purpose:'本地真實內控流程驗收用途'});return (r.results??r.output?.results)[0][0].id;};
 const act=async(procedure,id,who,extra={},status=200)=>{const r=await row('requests',id);return proc(who,procedure,{id,expectedVersion:r.version,...extra},status);};
 const small=await create('驗收：小額自動通過',9800);await act('submit-request',small,'requester');assert.equal((await row('requests',small)).data.state,'approved');
 const boundary=await create('驗收：一万元門檻',10000);await act('submit-request',boundary,'requester');assert.equal((await row('requests',boundary)).data.state,'manager_review');
 const large=await create('驗收：三級審批工作站',128000);await act('submit-request',large,'requester');await act('approve-manager',large,'manager');assert.equal((await row('requests',large)).data.state,'finance_review');await act('approve-finance',large,'finance');await act('place-order',large,'buyer');await act('receive-goods',large,'receiver');await act('pay-invoice',large,'finance',{invoiceAmountTwd:128001},409);await act('pay-invoice',large,'finance',{invoiceAmountTwd:128000});assert.equal((await row('requests',large)).data.state,'paid');check('small/boundary/large procurement and three-way invoice check');
 const self=await create('驗收：禁止自行核准',15000,'manager');await act('submit-request',self,'manager');await act('approve-manager',self,'manager',{},409);check('self approval denied');
 const role=await row('roles','role-manager');await proc('owner','configure-role',{id:role.id,expectedVersion:role.version,name:'暫停核准',request:true,approve:false,finance:false,purchase:false,receive:false});await act('approve-manager',boundary,'manager',{},409);
 const disabled=await row('roles','role-manager');await proc('owner','configure-role',{id:disabled.id,expectedVersion:disabled.version,name:'恢復核准',request:true,approve:true,finance:false,purchase:false,receive:false});await act('approve-manager',boundary,'manager');check('custom business role revoke/restore enforced by SQL');
 const tooLarge=await create('驗收：預算不足整批回滾',1000000);const budget=await row('budgets','budget-rd');await act('submit-request',tooLarge,'requester',{},400);assert.equal((await row('requests',tooLarge)).data.state,'draft');assert.deepEqual(await row('budgets','budget-rd'),budget);check('multi-statement SQL atomic budget rollback');
 const stale=await row('requests',boundary);await proc('buyer','place-order',{id:boundary,expectedVersion:stale.version-1},409);check('stale version rejected');
 await page.goto(origin+'/admin/c/notes');
 await page.getByRole('button',{name:'New entry',exact:true}).click();
 await page.getByLabel('標題',{exact:false}).fill('Alpha 管理後台真實操作公告');
 await page.getByLabel('內容',{exact:false}).fill('四組 host dialect 的原生後台 CRUD 與發布驗收。');
 await page.getByRole('combobox',{name:'優先度',exact:false}).click();
 await page.getByRole('option',{name:'Urgent',exact:true}).click();
 await Promise.all([page.waitForResponse(r=>r.request().method()==='PATCH'&&r.url().includes('/admin/api/entries/')),page.getByRole('button',{name:'Save changes',exact:true}).click()]);
 await page.getByRole('button',{name:'Publish',exact:true}).click();
 await page.getByRole('button',{name:'Unpublish',exact:true}).waitFor();
 await page.screenshot({path:output+'/05-published-note.png',fullPage:true});
 await page.getByRole('button',{name:'Unpublish',exact:true}).click();
 await page.getByRole('button',{name:'Publish',exact:true}).waitFor();
 check('real UI creates, edits enum, saves, publishes and unpublishes a draft');
 await page.goto(origin+'/admin/c/requests');await page.getByText('模擬請購',{exact:false}).first().waitFor();await page.screenshot({path:output+'/02-20k-requests.png',fullPage:true});
 await page.goto(origin+'/admin/c/roles');await page.getByText('自訂角色',{exact:false}).first().waitFor();await page.screenshot({path:output+'/03-roles.png',fullPage:true});
 await page.getByRole('link',{name:'請購審批與採購總表',exact:true}).click();
 await page.getByText('模擬請購',{exact:false}).first().waitFor();await page.screenshot({path:output+'/06-sql-report.png',fullPage:true});check('real SQL joined report UI');
 await page.goto(origin+'/admin/dev/overview/flow?selected=Procedure%3Asubmit-request');await page.getByRole('button',{name:'Expand flow',exact:true}).click();await page.getByText('已核准',{exact:true}).first().waitFor();await page.getByRole('button',{name:'Data dependencies',exact:true}).click();await page.getByRole('button',{name:'Data dependencies',exact:true}).click();await page.screenshot({path:output+'/04-manifest-flow.png',fullPage:true});
 assert.deepEqual(errors,[]);check('real populated Admin pages and developer graph have no page errors');
 await rm(output+'/failure.txt', { force: true });
 await rm(output+'/failure.png', { force: true });
 await writeFile(output+'/result.json',JSON.stringify({passed:true,name,origin,checks,requests:{small,boundary,large,self,tooLarge},provenance:JSON.parse(await readFile('provenance.json','utf8')),completedAt:new Date().toISOString()},null,2));
} catch(error) { if(page)await page.screenshot({path:output+'/failure.png',fullPage:true}).catch(()=>{}); await writeFile(output+'/failure.txt',String(error.stack));console.error(error);process.exitCode=1; }
finally { await browser.close(); }
