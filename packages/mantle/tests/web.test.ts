import { fixtureCaller } from "./apps/fixtures.js";
import {expect,test} from "bun:test";
import {Database} from "bun:sqlite";
import {mkdtemp,mkdir,rm,writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import ts from "typescript";
import {generateOrThrow,writeGenerated} from "./apps/link.js";

const source=`apiVersion: cms.mantle.aotter.net/v2
kind: Schema
metadata: {name: posts}
spec:
  title: Posts
  lifecycle: operational
  schema:
    type: object
    required: [slug, title, body, visible]
    properties:
      slug: {type: string}
      title: {type: string}
      body: {type: [string, "null"]}
      visible: {type: boolean}
---
apiVersion: cms.mantle.aotter.net/v2
kind: View
metadata: {name: posts}
spec:
  surface: public
  sql: SELECT id, slug, title FROM posts WHERE visible = true ORDER BY id LIMIT 2
---
apiVersion: cms.mantle.aotter.net/v2
kind: View
metadata: {name: post-by-slug}
spec:
  surface: public
  input:
    type: object
    required: [slug]
    additionalProperties: false
    properties: {slug: {type: string, minLength: 2}}
  sql: SELECT id, slug, body FROM posts WHERE slug = input.slug AND visible = true ORDER BY id
---
apiVersion: cms.mantle.aotter.net/v2
kind: View
metadata: {name: by-visible}
spec:
  surface: public
  input:
    type: object
    required: [visible]
    additionalProperties: false
    properties: {visible: {type: boolean}}
  sql: SELECT id, slug, body, visible FROM posts WHERE visible = input.visible ORDER BY id
---
apiVersion: cms.mantle.aotter.net/v2
kind: View
metadata: {name: posts-matching}
spec:
  surface: public
  input:
    type: object
    additionalProperties: false
    properties: {slug: {type: string}, title: {type: string}}
    anyOf: [{required: [slug]}, {required: [title]}]
  sql: SELECT id, slug, title FROM posts WHERE slug = input.slug OR title = input.title ORDER BY id
---
apiVersion: cms.mantle.aotter.net/v2
kind: View
metadata: {name: private-posts}
spec:
  surface: internal
  sql: SELECT id FROM posts ORDER BY id
`;

test("dynamic web output walks pages, trusts SQL visibility, escapes output and revalidates content",async()=>{
  const files=await generateOrThrow("bun-sqlite",[{sourceId:"blog.yaml",text:source}]);
  const dir=await mkdtemp(join(tmpdir(),"mantle-web-")),db=new Database(":memory:");
  try {
    await writeGenerated(dir,files);db.exec(files["schema.sql"]!);
    for(let i=0;i<7;i++) db.query("INSERT INTO posts(id,version,created_at,updated_at,slug,title,body,visible) VALUES (?,1,0,0,?,?,?,?)").run(String(i),i===1?"a&b)":"post"+i,"Title ["+i+"]","# body "+i,i===0?0:1);
    const {web}=await import(join(dir,"web.ts"));
    const site=web({db,caller:{kind:"anonymous"},origin:"https://site.test",title:"Blog",description:"Summary",locales:["en"],pages:{"/posts/{slug}":{view:"post-by-slug",list:"posts",markdown:"body"}}});
    expect(()=>web({db,caller:{kind:"anonymous"},origin:"https://site.test",title:"Blog",description:"Summary",pages:{"/posts/{slug}":{view:"post-by-slug",list:"posts-matching"}}})).toThrow("Page /posts/{slug} lists View 'posts-matching', whose input rejects an empty query; a list View must accept no input.");
    const request=(path:string,init?:RequestInit)=>new Request("https://untrusted.test"+path,init);
    const llms=await site.fetch(request("/llms.txt")),text=await llms.text();
    expect(text).toContain("# Blog\n\n> Summary");expect(text.match(/^- /gm)).toHaveLength(6);expect(text).not.toContain("post0");expect(text).toContain("Title \\[1\\]");expect(text).toContain("(https://site.test/posts/a%26b%29)");
    const sitemap=await site.fetch(request("/sitemap.xml"));expect((await sitemap.text()).match(/<url>/g)).toHaveLength(6);
    const md=await site.fetch(request("/posts/a%26b).md"));expect(await md.text()).toBe("# body 1");expect(md.headers.get("cache-control")).toBe("public, max-age=60");
    expect((await site.fetch(request("/posts/post0.md"))).status).toBe(404);expect(await site.head(request("/posts/post0"))).toBe("");
    const tags=await site.head(request("/posts/a%26b)"));expect(tags).toContain('rel="canonical" href="https://site.test/posts/a%26b%29"');expect(tags).toContain('type="text/markdown"');expect(tags).toContain('hreflang="en"');
    const etag=md.headers.get("etag");expect((await site.fetch(request("/posts/a%26b).md",{headers:{"if-none-match":"W/"+etag}}))).status).toBe(304);
    db.query("UPDATE posts SET body='changed' WHERE id='1'").run();const changed=await site.fetch(request("/posts/a%26b).md",{headers:{"if-none-match":etag}}));expect(changed.status).toBe(200);expect(changed.headers.get("etag")).not.toBe(etag);
    expect((await site.fetch(request("/posts/%xx.md"))).status).toBe(400);expect(await site.head(request("/posts/%xx"))).toBe("");expect(await site.head(request("/posts/x"))).toBe("");expect(await site.head(request("/posts/%61%26b)"))).toBe(await site.head(request("/posts/a&b)")));
    let resolved=0;const dynamic=web({db,caller:(req:Request,env:{admin:boolean})=>{resolved++;return env.admin?fixtureCaller({kind:"user",subject:"s",role:"editor",scopes:[],credential:"session",credentialId:null,clientId:null}):{kind:"anonymous"};},origin:"https://site.test",title:"Blog",description:"x",pages:{"/posts/{slug}":{view:"post-by-slug",markdown:"body"}}});
    expect((await dynamic.fetch(request("/posts/a%26b).md"),{admin:true})).headers.get("cache-control")).toBe("private, no-store");expect(resolved).toBe(1);
    db.query("INSERT INTO posts(id,version,created_at,updated_at,slug,title,body,visible) VALUES ('md',1,0,0,'readme.md','Readme','# Readme',1)").run();expect(await site.fetch(request("/posts/readme.md"))).toBeUndefined();expect(await (await site.fetch(request("/posts/readme.md.md"))).text()).toBe("# Readme");
    db.query("INSERT INTO posts(id,version,created_at,updated_at,slug,title,body,visible) VALUES ('null',1,0,0,'null','Null',NULL,1)").run();const nullMd=await site.fetch(request("/posts/null.md"));expect(nullMd.status).toBe(404);expect(nullMd.headers.get("cache-control")).toBe("no-store");
    const booleans=web({db,caller:{kind:"anonymous"},origin:"https://site.test",title:"x",description:"y",pages:{"/visibility/{visible}":{view:"by-visible",markdown:"body"}}});expect(await (await booleans.fetch(request("/visibility/true.md"))).text()).toBe("changed");expect((await booleans.fetch(request("/visibility/notbool.md"))).status).toBe(400);
    expect(await site.fetch(request("/unknown.md"))).toBeUndefined();expect(await site.fetch(request("/posts/a%26b)"))).toBeUndefined();expect(await site.fetch(request("/llms.txt",{method:"POST"}))).toBeUndefined();
    expect(await (await site.fetch(request("/llms.txt",{method:"HEAD"}))).text()).toBe("");
    const multilingual=web({db,caller:{kind:"anonymous"},origin:"https://site.test",title:"x",description:"y",locales:["en","zh"],pages:{"/posts/{slug}":{view:"post-by-slug",markdown:"body"}}});expect(await multilingual.head(request("/posts/a%26b)"))).toContain('hreflang="en"');expect(await multilingual.head(request("/posts/a%26b)"))).not.toContain('hreflang="zh"');
  }finally{db.close();await rm(dir,{recursive:true,force:true});}
});

test("public View and exact URL input names are typechecked on every target",async()=>{
  await mkdir(join(import.meta.dir,"apps/.generated/"),{recursive:true});
  const dir=await mkdtemp(join(import.meta.dir,"apps/.generated/","web-types-"));
  try {
    const roots:string[]=[];
    for(const target of ["bun-sqlite","bun-postgres","cloudflare-d1","cloudflare-postgres"] as const){
      const destination=join(dir,target);await writeGenerated(destination,await generateOrThrow(target,[{sourceId:"blog.yaml",text:source}]),false);
      const check=join(destination,"check.ts");await writeFile(check,`import {web} from './web.js';
const base={db:null as any,caller:{kind:'anonymous'} as const,origin:'https://site.test',title:'Blog',description:'Summary'};
web({...base,pages:{'/posts/{slug}':{view:'post-by-slug',list:'posts',markdown:'body'}}});
// @ts-expect-error unknown view
web({...base,pages:{'/posts/{slug}':{view:'missing'}}});
// @ts-expect-error internal view
web({...base,pages:{'/posts':{view:'private-posts'}}});
// @ts-expect-error wrong param
web({...base,pages:{'/posts/{id}':{view:'post-by-slug'}}});
// @ts-expect-error missing param
web({...base,pages:{'/posts':{view:'post-by-slug'}}});
// @ts-expect-error extra param
web({...base,pages:{'/posts/{slug}/{id}':{view:'post-by-slug'}}});
// @ts-expect-error list needs inputs
web({...base,pages:{'/posts/{slug}':{view:'post-by-slug',list:'post-by-slug'}}});
// @ts-expect-error a list View's input rules reject an empty query
web({...base,pages:{'/posts/{slug}':{view:'post-by-slug',list:'posts-matching'}}});
// @ts-expect-error unknown markdown column
web({...base,pages:{'/posts/{slug}':{view:'post-by-slug',markdown:'unknown'}}});
`);
      roots.push(check);
    }
    const program=ts.createProgram(roots,{strict:true,noEmit:true,skipLibCheck:true,target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.NodeNext,moduleResolution:ts.ModuleResolutionKind.NodeNext,types:["bun-types"],typeRoots:[join(import.meta.dir,"../node_modules/@types"),join(import.meta.dir,"../node_modules")],allowImportingTsExtensions:true});
    expect(ts.getPreEmitDiagnostics(program).map(d=>ts.flattenDiagnosticMessageText(d.messageText,"\n"))).toEqual([]);
  }finally{await rm(dir,{recursive:true,force:true});}
},30000);

test("publishing SQL keeps drafts out of all web outputs",async()=>{
  const {generateFromSources}=await import("../src/infrastructure/generate.js");
  const result=await generateFromSources({target:"bun-sqlite",sources:{sources:[{sourceId:"publishing-blog.yaml",text:source.replace("lifecycle: operational","lifecycle: publishing")}]}});
  if(!result.ok)throw Error(JSON.stringify(result.diagnostics));
  const dir=await mkdtemp(join(tmpdir(),"mantle-web-publishing-")),db=new Database(":memory:");
  try{
    await writeGenerated(dir,result.files);db.exec(result.files["schema.sql"]!);
    for(const [id,status] of [["draft","draft"],["public","published"]] as const)db.query("INSERT INTO posts(id,version,created_at,updated_at,slug,title,body,visible,status) VALUES (?,1,0,0,?,?,?,1,?)").run(id,id,id,"# "+id,status);
    const {web}=await import(join(dir,"web.ts"));
    for(const caller of [{kind:"anonymous"},fixtureCaller({kind:"user",subject:"editor",role:"editor",scopes:[],credential:"session",credentialId:null,clientId:null})]){
      const site=web({db,caller,origin:"https://site.test",title:"Blog",description:"Summary",pages:{"/posts/{slug}":{view:"post-by-slug",list:"posts",markdown:"body"}}});
      for(const path of ["/llms.txt","/sitemap.xml"]){const response=await site.fetch(new Request("https://site.test"+path));expect(response.status).toBe(200);const body=await response.text();expect(body).toContain("public");expect(body).not.toContain("draft");}
      expect((await site.fetch(new Request("https://site.test/posts/draft.md"))).status).toBe(404);
      expect(await site.head(new Request("https://site.test/posts/draft"))).toBe("");
      expect(await (await site.fetch(new Request("https://site.test/posts/public.md"))).text()).toBe("# public");
    }
  }finally{db.close();await rm(dir,{recursive:true,force:true});}
});

test("web indexes bound row scans and real cursor queries",async()=>{
  const files=await generateOrThrow("bun-sqlite",[{sourceId:"big-blog.yaml",text:source.replace("LIMIT 2","LIMIT 500")}]);
  const dir=await mkdtemp(join(tmpdir(),"mantle-web-cap-")),db=new Database(":memory:");
  try{
    await writeGenerated(dir,files);db.exec(files["schema.sql"]!);
    const insert=db.query("INSERT INTO posts(id,version,created_at,updated_at,slug,title,body,visible) VALUES (?,1,0,0,?,?,?,1)");
    db.transaction(()=>{for(let i=0;i<50504;i++)insert.run(String(i).padStart(5,"0"),"post"+i,"Title "+i,"# body");})();
    let queries=0;const handle={query(sql:string){queries++;return db.query(sql);},exec:db.exec.bind(db),transaction:db.transaction.bind(db)};
    const {web}=await import(join(dir,"web.ts"));const site=web({db:handle,caller:{kind:"anonymous"},origin:"https://site.test",title:"Blog",description:"x",pages:{"/posts/{slug}":{view:"post-by-slug",list:"posts",markdown:"body"}}});
    const sitemap=await site.fetch(new Request("https://site.test/sitemap.xml"));expect(sitemap.status).toBe(200);expect((await sitemap.text()).match(/<url>/g)).toHaveLength(50000);expect(queries).toBe(100);
    queries=0;const llms=await site.fetch(new Request("https://site.test/llms.txt"));expect((await llms.text()).match(/^- /gm)).toHaveLength(5000);expect(queries).toBe(10);
    const oneDir=join(dir,"one");await writeGenerated(oneDir,await generateOrThrow("bun-sqlite",[{sourceId:"one-blog.yaml",text:source.replace("LIMIT 2","LIMIT 1")} ]));
    const {web:oneWeb}=await import(join(oneDir,"web.ts"));const one=oneWeb({db:handle,caller:{kind:"anonymous"},origin:"https://site.test",title:"x",description:"y",pages:{"/posts/{slug}":{view:"post-by-slug",list:"posts",markdown:"body"}}});
    queries=0;expect((await (await one.fetch(new Request("https://site.test/sitemap.xml"))).text()).match(/<url>/g)).toHaveLength(100);expect(queries).toBe(100);
    queries=0;expect((await (await one.fetch(new Request("https://site.test/llms.txt"))).text()).match(/^- /gm)).toHaveLength(10);expect(queries).toBe(10);
    db.query("UPDATE posts SET slug='.' WHERE id='00000'").run();db.query("UPDATE posts SET slug='..' WHERE id='00001'").run();queries=0;const skip=await (await site.fetch(new Request("https://site.test/llms.txt"))).text();expect(skip).not.toContain("https://site.test/posts/.)");expect(skip).not.toContain("https://site.test/posts/..)");expect(skip.match(/^- /gm)).toHaveLength(4998);expect(queries).toBe(10);
    db.query("UPDATE posts SET title=? WHERE id='00002'").run("x".repeat(1024*1024));queries=0;const bounded=await (await site.fetch(new Request("https://site.test/llms.txt"))).text();expect(new TextEncoder().encode(bounded).length).toBeLessThanOrEqual(1024*1024);expect(queries).toBe(1);
  }finally{db.close();await rm(dir,{recursive:true,force:true});}
},30000);

test.skipIf(!process.env.MANTLE_NEXT_BUN_PG_URL)("Bun.SQL web uses real PostgreSQL cursor pages and current Markdown",async()=>{
  const {SQL}=await import("bun");const schema="web_"+crypto.randomUUID().replaceAll("-","");
  const admin=new SQL({url:process.env.MANTLE_NEXT_BUN_PG_URL!,max:1});await admin.unsafe('CREATE SCHEMA "'+schema+'"',[]);
  const db=new SQL({url:process.env.MANTLE_NEXT_BUN_PG_URL!,max:1,connection:{search_path:schema}}),dir=await mkdtemp(join(tmpdir(),"mantle-web-pg-"));
  try{
    const files=await generateOrThrow("bun-postgres",[{sourceId:"pg-blog.yaml",text:source.replace("LIMIT 2","LIMIT 500")}]);await writeGenerated(dir,files);await db.unsafe(files["schema.sql"]!,[]);
    await db.unsafe("INSERT INTO posts(id,version,created_at,updated_at,slug,title,body,visible) SELECT lpad(i::text,4,'0'),1,now(),now(),'post'||i,'Title '||i,'# body '||i,true FROM generate_series(0,1004) i",[]);
    const {web}=await import(join(dir,"web.ts"));let queries=0;
    const handle={unsafe:(sql:string,args:any[])=>{queries++;return db.unsafe(sql,args);},begin:db.begin.bind(db)};
    const site=web({db:handle,caller:{kind:"anonymous"},origin:"https://site.test",title:"PG",description:"x",pages:{"/posts/{slug}":{view:"post-by-slug",list:"posts",markdown:"body"}}});
    const sitemap=await site.fetch(new Request("https://site.test/sitemap.xml"));expect(sitemap.status).toBe(200);expect((await sitemap.text()).match(/<url>/g)).toHaveLength(1005);expect(queries).toBe(3);
    queries=0;expect((await (await site.fetch(new Request("https://site.test/llms.txt"))).text()).match(/^- /gm)).toHaveLength(1005);expect(queries).toBe(3);
    const md=await site.fetch(new Request("https://site.test/posts/post503.md"));expect(await md.text()).toBe("# body 503");const tags=await site.head(new Request("https://request.test/posts/%70ost503"));expect(tags).toContain('href="https://site.test/posts/post503"');
    const etag=md.headers.get("etag");await db.unsafe("UPDATE posts SET body='changed' WHERE slug='post503'",[]);const changed=await site.fetch(new Request("https://site.test/posts/post503.md",{headers:{"if-none-match":etag}}));expect(changed.status).toBe(200);expect(await changed.text()).toBe("changed");
  }finally{await db.close();await admin.unsafe('DROP SCHEMA "'+schema+'" CASCADE',[]);await admin.close();await rm(dir,{recursive:true,force:true});}
});

test("a Worker importing a View does not bundle optional web",async()=>{
  const {build}=await import("esbuild");const files=await generateOrThrow("cloudflare-d1",[{sourceId:"blog.yaml",text:source}]);
  const dir=await mkdtemp(join(tmpdir(),"mantle-web-tree-"));
  try{
    await writeGenerated(dir,files);const entry=join(dir,"worker.ts");await writeFile(entry,'import query from "./views/posts.js";export default {fetch:async (_request:Request,env:any)=>Response.json(await query(env.DB,{kind:"anonymous"},{}))};');
    const result=await build({entryPoints:[entry],bundle:true,write:false,metafile:true,platform:"neutral",format:"esm",target:"es2022"});
    expect(Object.keys(result.metafile!.inputs).some(name=>name.endsWith("/web.ts"))).toBe(false);expect(result.outputFiles![0]!.text).not.toContain("llms.txt");expect(result.outputFiles![0]!.text).not.toContain("SHA-256");
  }finally{await rm(dir,{recursive:true,force:true});}
});
