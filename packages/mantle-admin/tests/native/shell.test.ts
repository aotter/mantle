import {test,expect} from "bun:test";
import {adminShell} from "../../src/server/shell.js";
const assets=(path:string)=>{
  const html=(body:string)=>new Response(body,{headers:{"content-type":"text/html; charset=utf-8","content-security-policy":"img-src 'self'"}});
  if(path==="index.html")return html("shell");
  if(path==="preview.html")return html("preview");
  if(path==="assets/app.js")return new Response("boot()",{headers:{"content-type":"text/javascript"}});
  return new Response("missing",{status:404});
};
const get=(path:string)=>adminShell(new Request("https://app.test"+path),assets);
test("every shell page is anti-framed, never cached and nosniff; files only nosniff",async()=>{
  for(const path of ["/admin","/admin/","/admin/index.html","/admin//index.html","/admin/c/posts","/admin/members/a.b@x.test"]){
    const r=(await get(path))!;
    expect([path,r.status,await r.text()]).toEqual([path,200,"shell"]);
    expect([r.headers.get("content-security-policy"),r.headers.get("x-frame-options"),r.headers.get("cache-control"),r.headers.get("x-content-type-options")]).toEqual(["img-src 'self', frame-ancestors 'none'","DENY","no-store","nosniff"]);
  }
  const js=(await get("/admin/assets/app.js"))!;
  expect([js.status,await js.text(),js.headers.get("x-content-type-options"),js.headers.get("x-frame-options"),js.headers.get("content-security-policy")]).toEqual([200,"boot()","nosniff",null,null]);
  const preview=(await get("/admin/preview.html"))!;
  expect([preview.status,preview.headers.get("x-frame-options"),preview.headers.get("x-content-type-options")]).toEqual([200,null,"nosniff"]);
});
test("the MCP App is a file, not a client route: anti-framed and never cached when built, 404 and not the shell when it is not",async()=>{
  const app=(path:string)=>path==="mcp-app.html"?new Response("app",{headers:{"content-type":"text/html"}}):assets(path);
  const served=(await adminShell(new Request("https://app.test/admin/mcp-app.html"),app))!;
  expect([served.status,await served.text(),served.headers.get("content-security-policy"),served.headers.get("x-frame-options"),served.headers.get("cache-control")]).toEqual([200,"app","frame-ancestors 'none'","DENY","no-store"]);
  // `assets` has no mcp-app.html: the shell is for client routes, and a host reads the file only through the MCP resource
  expect([(await get("/admin/mcp-app.html"))?.status,(await get("/admin/other.html"))?.status]).toEqual([404,200]);
});
test("traversal, encoded separators and NUL are refused; missing built files stay 404; other requests pass through",async()=>{
  for(const path of ["/admin/..%2f..%2fsecret.txt","/admin/x%5cy.txt","/admin/a%2Fb","/admin/x%00.js","/admin/%E0%A4","/admin/%2e%2e%2fsecret"])expect([path,(await get(path))?.status]).toEqual([path,404]);
  for(const path of ["/admin/assets/gone.js"])expect([path,(await get(path))?.status]).toEqual([path,404]);
  // the documented callback resolves the path against /admin/: a double-encoded dot segment must not climb out of it
  const documented=(path:string)=>new URL("/admin/"+path,"https://app.test").pathname==="/private/report.pdf"?new Response("secret"):new Response("missing",{status:404});
  for(const path of ["/admin/%252e%252e/private/report.pdf","/admin/.%252e/private/report.pdf","/admin/%252E%252e/private/report.pdf","/admin/x/%252e%252e/%252e%252e/private/report.pdf",
    // the URL parser drops tabs and newlines, so `\t..` becomes `..`
    "/admin/%09../private/report.pdf","/admin/%0a../private/report.pdf","/admin/%0d../private/report.pdf","/admin/.%09./private/report.pdf","/admin/..%09/private/report.pdf","/admin/%09..%09/private/report.pdf"])
    expect([path,(await adminShell(new Request("https://app.test"+path),documented))?.status]).toEqual([path,404]);
  expect(await get("/administrator")).toBeUndefined();
  expect(await get("/elsewhere")).toBeUndefined();
  expect(await adminShell(new Request("https://app.test/admin",{method:"POST"}),assets)).toBeUndefined();
});
test("a non-default auth base is announced to the SPA; the default leaves the page untouched",async()=>{
  const page=(body:string)=>()=>new Response(body,{headers:{"content-type":"text/html"}});
  const staff=(await adminShell(new Request("https://app.test/admin"),page("<head></head>"),{authBasePath:"/api/auth/staff/"}))!;
  expect(await staff.text()).toBe('<head><meta name="mantle-auth-base" content="/api/auth/staff"></head>');
  expect(await (await adminShell(new Request("https://app.test/admin"),page("<head></head>"),{authBasePath:"/api/auth"}))!.text()).toBe("<head></head>");
  await expect(adminShell(new Request("https://app.test/admin"),page(""),{authBasePath:'/x"><script>'})).rejects.toThrow("authBasePath");
});
