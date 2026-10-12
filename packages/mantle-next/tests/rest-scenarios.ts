/** One response/state oracle shared by actual SQLite, D1 and PostgreSQL REST hosts. */
import assert from "node:assert/strict";
export async function verifyRest(fetch: (request: Request) => Promise<Response | undefined>): Promise<void> {
  const request = (path: string, method = "GET", body?: unknown, headers: Record<string,string> = {}) => fetch(new Request("https://app.test"+path, {method, ...(body === undefined ? {} : {body: JSON.stringify(body)}), headers}));
  const first = await request("/api/views/notes?limit=1"); assert.equal(first!.status,200); assert.equal(first!.headers.get("cache-control"),"private, no-store");
  const page = await first!.json() as any; assert.deepEqual(page.rows,[{id:"a",title:"a"}]);
  const second = await request("/api/views/notes?limit=1&cursor="+encodeURIComponent(page.nextCursor)); assert.deepEqual((await second!.json() as any).rows,[{id:"b",title:"b"}]);
  const edit = {title:"x",version:1}, editor = {"x-role":"staff"};
  for (const [path,method,body,headers,status] of [
    ["/api/views/notes?limit=bad","GET",undefined,{},400],
    ["/api/notes/a","PUT",edit,{},401],
    ["/api/notes/a","PUT",edit,{"x-role":"none"},403],
    ["/api/notes/a","PUT",edit,editor,200],
    ["/api/notes/a","PUT",edit,editor,409],
    ["/api/missing","GET",undefined,{},404],
    ["/api/views/staff-notes","GET",undefined,editor,404],
    ["/api/views/notes","POST",undefined,{},405],
    ["/api/notes/a","PUT",{title:"x",version:2},{...editor,"x-credential":"session",origin:"https://evil.test"},403],
  ] as const) assert.equal((await request(path,method,body,headers))!.status,status,path);
  const method = await request("/api/views/notes","POST"); assert.equal(method!.headers.get("allow"),"GET");
  const csrf = await request("/api/notes/a","PUT",{title:"x",version:2},{...editor,"x-credential":"session",origin:"https://evil.test"}); assert.equal((await csrf!.json() as any).error.path,"request:origin");
  const options = await request("/api/options","POST",{id:"a",approved:true,payload:{hello:"world"}},editor); assert.equal(options!.status,200);
  const row = (await options!.json() as any).results[0][0]; assert.equal(Boolean(row.approved),true); assert.deepEqual(typeof row.payload === "string" ? JSON.parse(row.payload) : row.payload,{hello:"world"});
  const posts = await request("/api/views/posts"); assert.deepEqual((await posts!.json() as any).rows,[{id:"published",title:"public"}]);
  const echo = await request("/api/echo","POST",{message:"hello"},editor); assert.equal(echo!.status,200); assert.deepEqual(await echo!.json(),{reply:"hello",title:"x"});
  assert.equal((await request("/api/echo","POST",{message:"hello"}))!.status,401);
  assert.equal((await request("/api/echo","POST",{message:3},editor))!.status,400);
  assert.equal(await request("/custom"),undefined);
}
