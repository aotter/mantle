import {test,expect} from "bun:test";
import {checkOrigin,type Caller} from "../src/kernel/contracts.js";
const session:Caller={kind:"user",subject:"s",role:null,scopes:[],credential:"session",credentialId:null,clientId:null};
test("shared origin rule rejects ambient cross-origin writes and preserves explicit credentials",()=>{
 const request=(method:string,headers?:Record<string,string>)=>new Request("https://app.test/api/items",{method,headers});
 for(const headers of [{} as Record<string,string>,{origin:"https://evil.test"},{"sec-fetch-site":"same-site"},{"sec-fetch-site":"cross-site",origin:"https://app.test"}]) expect(()=>checkOrigin(request("POST",headers),session)).toThrow(expect.objectContaining({code:"AUTH_DENIED",path:"request:origin"}));
 for(const headers of [{origin:"https://app.test"},{"sec-fetch-site":"same-origin"},{"sec-fetch-site":"none"}] as Record<string,string>[]) expect(()=>checkOrigin(request("POST",headers),session)).not.toThrow();
 for(const method of ["GET","HEAD","OPTIONS"]) expect(()=>checkOrigin(request(method,{origin:"https://evil.test"}),session)).not.toThrow();
 for(const caller of [{kind:"anonymous"},{kind:"system",reason:"test"},{...session,credential:"api-key"},{...session,credential:"oauth"},{...session,credential:"personal-token"}] as Caller[]) expect(()=>checkOrigin(request("DELETE"),caller)).not.toThrow();
});
test("resolver ContractErrors keep their status and challenge; other resolver failures are 500 without one",async()=>{
 const {surfaceCaller,surfaceFailure,ContractError}=await import("../src/kernel/contracts.js");
 const {spyOn}=await import("bun:test");const log=spyOn(console,"error").mockImplementation(()=>{});
 try {
  const request=new Request("https://app.test");let error:unknown;
  // resolveCaller rejects an invalid or expired bearer token with UNAUTHENTICATED: the client must see 401 + challenge to refresh.
  try {await surfaceCaller(request,{},async()=>{throw new ContractError("UNAUTHENTICATED","Invalid access token.");});} catch(value) {error=value;}
  const expired=surfaceFailure(error,"Bearer");expect(expired.status).toBe(401);expect(expired.headers.get("www-authenticate")).toBe("Bearer");
  try {await surfaceCaller(request,{},async()=>{throw new Error("private detail");});} catch(value) {error=value;}
  const failure=surfaceFailure(error,"Bearer");expect(failure.status).toBe(500);expect(failure.headers.get("www-authenticate")).toBeNull();expect(await failure.json()).toMatchObject({error:{code:"INTERNAL_ERROR"}});expect(log.mock.calls).toEqual([["[mantle surface] unhandled failure",error]]);
  const denied=surfaceFailure(new ContractError("UNAUTHENTICATED","Sign in."),"Bearer scope=read");expect(denied.status).toBe(401);expect(denied.headers.get("www-authenticate")).toBe("Bearer scope=read");
  const csrf=surfaceFailure(new ContractError("AUTH_DENIED","Origin refused.","request:origin"),"Bearer");expect(csrf.headers.get("www-authenticate")).toBeNull();
 } finally {log.mockRestore();}
});
