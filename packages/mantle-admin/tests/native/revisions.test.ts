import {expect,test} from "bun:test";
import {Database} from "bun:sqlite";
import {mkdtemp,readFile,rm,writeFile} from "node:fs/promises";
import {join,resolve} from "node:path";
import {admin as createAdmin} from "../../src/server/index.js";
import {entries} from "../../src/server/entries.js";
import {generateAdmin,writeAdminFixture} from "./generated-fixture.js";
import {admin} from "./server-native-scenarios.js";
import {createInteractionController} from "@aotter/mantle-ui/controller";
import {parentRefScopes,parentScopeInteraction,workbenchParentScope} from "../../admin/src/features/ops/interaction-schema.js";

// docs/handbook/guides/revisions.md through Admin's own routes: the manifests and handler are the guide's (see packages/mantle/tests/revisions.test.ts).
const sdkTests=resolve(import.meta.dir,"../../../mantle/tests");
const guide=()=>readFile(resolve(import.meta.dir,"../../../../docs/handbook/guides/revisions.md"),"utf8");

test("the revisions guide in Admin: revisions fold under their post, and the post's operations start, switch and refuse",async()=>{
 const files=await generateAdmin("bun-sqlite",await readFile(join(sdkTests,"apps/revisions.yaml"),"utf8"));
 const dir=await mkdtemp(join(sdkTests,"apps/.admin-revisions-")),db=new Database(":memory:");
 try{
  await writeAdminFixture(dir,files); db.exec(files["schema.sql"]!);
  const handler=[...(await guide()).matchAll(/^```ts\n([\s\S]*?)^```$/gm)].map(m=>m[1]!).find(block=>block.includes("export const handlers"))!;
  await writeFile(join(dir,"handlers.ts"),handler.replace("../generated/generated.js","./generated.js"));
  const {handlers}=await import(join(dir,"handlers.ts"));
  const {adminBindings}=await import(join(dir,"admin-bindings.ts")),bindings=adminBindings({handlers});
  const fetch=createAdmin(bindings.metadata,bindings.views,bindings.operations,{db:()=>db,caller:()=>admin,routes:entries(bindings.schemas,bindings.adapter)});
  const call=async(path:string,method="GET",input?:unknown)=>{const response=(await fetch(new Request("https://app.test/admin/api"+path,{method,headers:{origin:"https://app.test","content-type":"application/json"},body:input===undefined?undefined:JSON.stringify(input)}),{}))!;return {status:response.status,body:await response.json() as any};};
  const ok=async(path:string,method="GET",input?:unknown)=>{const result=await call(path,method,input);expect(result).toMatchObject({status:200});return result.body;};
  const operation=async(name:string,input:any)=>call(`/operations/${name}`,"POST",name==="switch-revision"?{expectedRevisionVersion:(await ok(`/entries/${input.revision}?collection=post_revisions`)).entry.version,...input}:input);
  const post=async(id:string)=>(await ok(`/entries/${id}?collection=posts`));
  // What the public post-page View joins (tests/revisions.test.ts runs the View itself).
  const page=()=>db.query("SELECT r.body FROM posts p JOIN post_revisions r ON r.id = p.current_revision WHERE p.slug = 'hello' AND p.status = 'published'").all().map((r:any)=>r.body);

  // Navigation: revisions fold under their post; the operations sit on the post's page and the revision rows.
  expect(bindings.metadata.collections.find((c:any)=>c.name==="post_revisions").parent).toMatchObject({collection:"posts",parentField:"id",childField:"post"});
  const operations=(await ok("/operations")).operations;
  const bound=(name:string)=>operations.find((o:any)=>o.name===name);
  expect(bound("new-revision")).toMatchObject({interactions:[{collection:"posts",bind:[{input:"post",field:"id"}]}],uiSchema:{collectionAction:"post_revisions"}});
  expect(bound("switch-revision")).toMatchObject({interactions:[{collection:"posts",bind:[{input:"post",field:"id"}],version:"expectedVersion"}]});
  expect(bound("prune-revision")).toMatchObject({interactions:[{collection:"post_revisions",bind:[{input:"id",field:"id"}]}]});

  // An editor creates the draft post in Admin, starts its first revision from the post and writes it in the record form.
  const hello=(await ok("/entries","POST",{collection:"posts",data:{slug:"hello",current_revision:"ignored"}})).entry;
  expect(hello.data.current_revision??null).toBeNull(); // readOnly: the generic create does not take it
  const first=(await operation("new-revision",{post:hello.id})).body.output.results[0][0];
  const firstEntry=(await ok(`/entries/${first.id}?collection=post_revisions`)).entry;
  const elsewhere=(await ok("/entries","POST",{collection:"posts",data:{slug:"elsewhere"}})).entry;
  const edited=(await ok(`/entries/${first.id}?collection=post_revisions`,"PATCH",{data:{title:"Hello",summary:"The first post.",body:"Version one.",post:elsewhere.id,sealed:true},expectedVersion:firstEntry.version})).entry;
  expect(edited.data).toMatchObject({post:hello.id,title:"Hello",sealed:false}); // readOnly: the record form cannot move a revision
  const workbench=await post(hello.id);
  expect(workbench.related.find((s:any)=>s.collection.name==="post_revisions").entries.map((e:any)=>e.id)).toEqual([first.id]);
  expect((await ok(`/entries?collection=post_revisions&scope_field=post&scope_value=${hello.id}`)).items.map((e:any)=>e.id)).toEqual([first.id]);
  expect((await ok(`/entries/${first.id}?collection=post_revisions`)).parentEntryId).toBe(hello.id);

  // New revision from the post's revision panel (aotter/mantle#1824): the panel's scope binds `post`, the input named
  // like the child's nav.parentField, to this post, as CollectionView passes it to the header's operation dialog.
  const revisions=(await ok("/collections")).collections.find((c:any)=>c.name==="post_revisions");
  const panel=workbench.related.find((s:any)=>s.collection.name==="post_revisions").relationship;
  const scoped=parentScopeInteraction(bound("new-revision").input,workbenchParentScope(revisions,{field:panel.childField,value:String(panel.parentValue)}))!;
  expect(scoped).toEqual({interaction:{collection:"posts",bind:[{input:"post",field:"post"}],mutates:true},row:{post:hello.id}});
  const dialog=createInteractionController({...scoped,invoke:async values=>{const result=await operation("new-revision",values);return result.status===200?{ok:true,data:result.body.output}:{ok:false,diagnostics:[result.body.error]};}});
  await dialog.open();
  expect(dialog.getSnapshot()).toMatchObject({phase:"ready",bound:{post:hello.id}});
  await dialog.submit();
  const fromPanel=(dialog.getSnapshot().result as any).results[0][0];
  expect((await ok(`/entries/${fromPanel.id}?collection=post_revisions`)).entry.data.post).toBe(hello.id);
  await ok(`/entries/${fromPanel.id}?collection=post_revisions`,"DELETE");

  // current_revision is required: Admin refuses to publish a post without a revision, naming the field.
  expect(await call(`/entries/${hello.id}/publish?collection=posts`,"POST",{expectedVersion:hello.version})).toMatchObject({status:400,body:{error:{code:"INPUT_VALIDATION_FAILED",path:"schemas/posts/admin/input/current_revision"}}});

  // Switch, then publish: the page is live.
  expect(await operation("switch-revision",{post:hello.id,revision:first.id,expectedVersion:hello.version})).toMatchObject({status:200});
  const draft=(await post(hello.id)).entry;
  expect(draft.data.current_revision).toBe(first.id);
  await ok(`/entries/${hello.id}/publish?collection=posts`,"POST",{expectedVersion:draft.version});
  expect(page()).toEqual(["Version one."]);

  // The sealed_revision lock: Admin knows the current revision is frozen before the edit, and its generic patch and delete
  // refuse it with CONFLICT kind lock; the page is unchanged.
  const message="This revision is sealed. Start a New revision from its post, edit and preview it, then Switch revision.";
  const liveRevision=(await ok(`/entries/${first.id}?collection=post_revisions`)).entry;
  expect(liveRevision.locks).toEqual({update:{lock:"sealed_revision",message},delete:{lock:"sealed_revision",message}});
  const refused=await call(`/entries/${first.id}?collection=post_revisions`,"PATCH",{data:{body:"Edited live."},expectedVersion:liveRevision.version});
  expect(refused).toMatchObject({status:409,body:{error:{code:"CONFLICT",kind:"lock",schema:"post_revisions",lock:"sealed_revision",message}}});
  expect((await call(`/entries/${first.id}?collection=post_revisions`,"DELETE")).body.error).toMatchObject({code:"CONFLICT",kind:"lock",verb:"delete"});
  expect(page()).toEqual(["Version one."]);

  // The record form cannot edit the published post; the next revision goes through the post's operations.
  const live=(await post(hello.id)).entry;
  expect((await call(`/entries/${hello.id}?collection=posts`,"PATCH",{data:{slug:"renamed"},expectedVersion:live.version})).status).not.toBe(200);
  const second=(await operation("new-revision",{post:hello.id})).body.output.results[0][0];
  const copy=(await ok(`/entries/${second.id}?collection=post_revisions`)).entry;
  expect(copy.data).toMatchObject({post:hello.id,title:"Hello",body:"Version one."});
  expect(copy.locks).toEqual({update:false,delete:false}); // not live: the record form edits it
  await ok(`/entries/${second.id}?collection=post_revisions`,"PATCH",{data:{body:"Version two."},expectedVersion:copy.version});
  expect(page()).toEqual(["Version one."]);
  const foreign=(await operation("new-revision",{post:elsewhere.id})).body.output.results[0][0];

  // Switch revision on this post (aotter/mantle#1825): its `revision` picker lists only this post's revisions, read
  // with the folded list's scope; other refs and other operations list the whole target.
  const collections=(await ok("/collections")).collections,switching=bound("switch-revision");
  const scopes=parentRefScopes(switching.input,switching.interactions[0],(await post(hello.id)).entry,collections);
  expect(scopes).toEqual({revision:{field:"post",value:hello.id}});
  const picker=new URLSearchParams({collection:"post_revisions",limit:"20",sort:"updatedAt",direction:"desc",scope_field:scopes.revision!.field,scope_value:scopes.revision!.value});
  expect((await ok(`/entries?${picker}`)).items.map((e:any)=>e.id).sort()).toEqual([first.id,second.id].sort());
  expect((await ok("/entries?collection=post_revisions&limit=20")).items.map((e:any)=>e.id)).toContain(foreign.id);
  expect(parentRefScopes(bound("prune-revision").input,bound("prune-revision").interactions[0],{id:first.id},collections)).toEqual({});
  expect((await operation("switch-revision",{post:hello.id,revision:foreign.id,expectedVersion:live.version})).status).toBe(400);
  expect((await operation("switch-revision",{post:hello.id,revision:second.id,expectedVersion:live.version-1})).status).toBe(409);
  expect(page()).toEqual(["Version one."]);
  expect(await operation("switch-revision",{post:hello.id,revision:second.id,expectedVersion:live.version})).toMatchObject({status:200});
  expect(page()).toEqual(["Version two."]);
  expect((await post(hello.id)).entry.status).toBe("published");

  // Rollback, and pruning refuses the current revision.
  expect(await operation("switch-revision",{post:hello.id,revision:first.id,expectedVersion:live.version+1})).toMatchObject({status:200});
  expect(page()).toEqual(["Version one."]);
  expect((await operation("prune-revision",{id:first.id})).body.error).toMatchObject({code:"CONFLICT",kind:"lock"});
  expect((await ok(`/entries/${second.id}?collection=post_revisions`)).entry.locks.update).toMatchObject({lock:"sealed_revision"}); // history stays sealed
  expect(await operation("prune-revision",{id:second.id})).toMatchObject({status:409});
  const unused=(await operation("new-revision",{post:hello.id})).body.output.results[0][0];
  expect(await operation("prune-revision",{id:unused.id})).toMatchObject({status:200});
  expect((await post(hello.id)).related.find((s:any)=>s.collection.name==="post_revisions").entries.map((e:any)=>e.id).sort()).toEqual([first.id,second.id].sort());
 }finally{db.close();await rm(dir,{recursive:true,force:true});}
},30000);
