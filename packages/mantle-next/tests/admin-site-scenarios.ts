import assert from "node:assert/strict";
import type {MediaStorage} from "../src/kernel/site-types.js";
export const adminSiteDefaults={brand:"Seed",locales:["en","zh-TW"],media:{purposes:[{name:"cover",required:["png"],maxBytes:{"image/png":100}}]}};
export const adminSiteStaff={kind:"user" as const,subject:"staff",role:"staff" as const,scopes:[],credential:"session" as const,credentialId:null,clientId:null};
export const adminSiteStorage:MediaStorage={
  async createUpload(a){return {capabilities:a.variants.map(v=>({...v,method:"PUT" as const,uploadUrl:"https://upload.test/"+a.uploadGroupId,storageKey:"uploads/"+a.uploadGroupId}))};},
  async commitUpload(a){return {id:a.uploadGroupId,createdAt:a.now,alt:a.alt,caption:a.caption,variants:a.variants.map(v=>({mimeType:v.mimeType,role:v.role,storageKey:"committed/"+a.uploadGroupId,publicUrl:"https://media.test/"+a.uploadGroupId,byteSize:90}))};},
  async deleteObject(){},
};
export async function verifyAdminSite(fetch:(request:Request)=>Promise<Response>,cookie:string) {
  let checks=0;
  const req=(path:string,method="GET",body?:unknown,headers:Record<string,string>={})=>fetch(new Request("https://app.test/admin/api"+path,{method,headers:{cookie,origin:"https://app.test",...headers},...(body===undefined?{}:{body:JSON.stringify(body)})}));
  const json=async(path:string,method="GET",body?:unknown):Promise<any>=>{const response=await req(path,method,body);assert.equal(response.status,200,path+": "+await response.clone().text());assert.equal(response.headers.get("cache-control"),"no-store");checks++;return response.json();};
  assert.deepEqual(await json("/site-settings"),{brand:"Seed",title:"CMS",description:""});
  assert.deepEqual(await json("/site-settings","PATCH",{brand:"Edited",title:"Title",origin:"https://evil.test"}),{brand:"Edited",title:"Title",description:""});
  assert.equal((await req("/site-settings","PATCH",{title:"x".repeat(201)})).status,400);checks++;
  const info=await json("/site");assert.equal(info.publicUrl,"https://app.test");assert.deepEqual(info.locales,["en","zh-TW"]);assert.deepEqual(info.capabilities,{siteSettings:true,media:true,invitationEmail:true,statistics:false});
  const upload=await json("/media/uploads","POST",{filename:"a.png",purpose:"cover",variants:[{mimeType:"image/png",role:"primary",byteSize:90}]});
  const asset=await json("/media/uploads/"+upload.uploadGroupId+"/commit","POST",{caption:"Cat"});assert.equal(asset.primaryUrl,"https://media.test/"+asset.id);assert.equal(asset.mime,"image/png");assert.equal(asset.byteSize,90);
  assert.equal((await json("/media?search=cat")).items.length,1);
  assert.equal((await json("/media/"+asset.id)).id,asset.id);
  assert.equal((await json("/media/"+asset.id,"PATCH",{alt:""})).alt,"");
  assert.deepEqual(await json("/media/"+asset.id,"DELETE"),{deleted:true,variantsRemoved:1});
  assert.equal((await req("/media/"+asset.id)).status,404);checks++;
  for(const path of ["/media?limit=1.5","/media?limit=501","/media?cursor=01","/media?search=%00","/members?search=%00","/members?limit=101","/members?cursor_direction=sideways","/members?cursor=bad"]){assert.equal((await req(path)).status,400,path);checks++;}
  const members=await json("/members?limit=1");assert.equal(members.items.length,1);assert.equal(members.items[0].role,undefined);assert.ok(members.next_cursor);
  const next=await json("/members?limit=1&cursor="+encodeURIComponent(members.next_cursor));assert.notEqual(next.items[0].id,members.items[0].id);
  const previous=await json("/members?limit=1&cursor_direction=backward&cursor="+encodeURIComponent(next.previous_cursor));assert.equal(previous.items[0].id,members.items[0].id);
  assert.deepEqual((await json("/staff")).users.map((u:any)=>u.id),["staff"]);
  assert.equal((await req("/staff/staff/role","PATCH",{role:null})).status,403);checks++;
  assert.equal((await req("/staff/m1/role","PATCH",{role:"owner"})).status,400);checks++;
  assert.equal((await req("/staff/missing/role","PATCH",{role:"staff"})).status,404);checks++;
  await json("/staff/m1/role","PATCH",{role:"staff"});assert.deepEqual(new Set((await json("/staff")).users.map((u:any)=>u.id)),new Set(["staff","m1"]));
  await json("/staff/m1/role","PATCH",{role:null});
  assert.equal((await req("/staff/invitations","POST",{email:"pending@example.test",role:"staff"})).status,403);checks++;
  const invite=await json("/staff/invitations","POST",{email:" INVITED@example.test ",role:"staff"});assert.equal(invite.emailSent,true);
  await json("/staff/invitations/"+invite.userId,"DELETE");
  assert.equal((await req("/staff/invitations/m1","DELETE")).status,409);checks++;
  const wrong=await req("/media","POST",{});assert.equal(wrong.status,405);assert.equal(wrong.headers.get("allow"),"GET");checks++;
  return {checks};
}
