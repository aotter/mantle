import { afterEach, expect, test, vi } from "vitest";
import { api, downloadAdminFile, csvCell, type ApiError } from "./api";

afterEach(() => vi.unstubAllGlobals());

test("download delegates streaming to the browser and retains filters", async () => {
  const link = {href:"",download:"",click:vi.fn(),remove:vi.fn()};
  const fetch=vi.fn();
  vi.stubGlobal("window",{location:{href:"https://site.test/admin",origin:"https://site.test"}});
  vi.stubGlobal("document",{createElement:()=>link,body:{append:vi.fn()},querySelector:()=>null});
  vi.stubGlobal("fetch",fetch);
  await downloadAdminFile("/admin/api/entries/export?collection=items&status=draft&cursor=old");
  expect(link.href).toBe("https://site.test/admin/api/entries/export?collection=items&status=draft");
  expect(link.download).toBe("items.csv");
  expect(link.click).toHaveBeenCalledOnce(); expect(link.remove).toHaveBeenCalledOnce();
  expect(fetch).not.toHaveBeenCalled();
  await expect(downloadAdminFile("https://other.test/admin/api/views/people/export")).rejects.toThrow("Admin download URL");
  await expect(downloadAdminFile("/oauth/consents/revoke")).rejects.toThrow("Admin download URL");
  expect(csvCell(" \t@formula")).toBe("' \t@formula"); expect(csvCell(-3)).toBe("-3");
});

test("entry refusals read authority once, preserve the draft and never retry the write", async () => {
  const input={expectedVersion:1,data:{title:"Unsaved"}};
  const fetch=vi.fn(async(_url:unknown,init?:RequestInit)=>init?.method
    ? Response.json({error:{code:"CONFLICT",message:"Guard refused."}},{status:409})
    : Response.json({entry:{version:2,data:{title:"Changed elsewhere"}}}));
  vi.stubGlobal("fetch",fetch);
  await expect(api.patch("/entries/item?collection=notes",input)).rejects.toMatchObject({status:409,message:expect.stringContaining("current version is v2")});
  expect(fetch.mock.calls.map(([,init])=>init?.method??"GET")).toEqual(["PATCH","GET"]);
  expect(fetch.mock.calls[1]![0]).toBe("/admin/api/entries/item?collection=notes");
  expect(input).toEqual({expectedVersion:1,data:{title:"Unsaved"}});
});

test("entry guard and uncertain failures retain their outcome after re-read; unrelated routes do no extra read",async()=>{
  for(const code of ["CONFLICT","OUTCOME_UNKNOWN"]){
    const fetch=vi.fn(async(_url:unknown,init?:RequestInit)=>init?.method
      ? Response.json({error:{code,message:"Refused."}},{status:code==="CONFLICT"?409:503})
      : Response.json({entry:{version:1,data:{}}}));
    vi.stubGlobal("fetch",fetch);
    const failure=await api.post("/entries/item/publish?collection=notes",{}).catch(error=>error);
    expect(failure).toMatchObject({body:{error:{code}},message:expect.stringContaining(code==="CONFLICT"?"write conditions no longer match":"still unconfirmed")});
    expect(fetch.mock.calls.map(([,init])=>init?.method??"GET")).toEqual(["POST","GET"]);
    fetch.mockClear();
    await expect(api.post("/operations/edit",{})).rejects.toMatchObject({body:{error:{code}}});
    expect(fetch).toHaveBeenCalledOnce();
  }
});

test("a Schema check refusal is not a stale write: no re-read, no concurrent-change advice, no generated constraint name (#1910)",async()=>{
  for(const [check,shown] of [["_mantle_chk_feedback_1",false],["requestStatus <> 'shipped' OR releaseUrl IS NOT NULL",true]] as const){
    const error={code:"CONFLICT",message:`A check of the Schema failed: feedback: ${check}`,path:"schemas/feedback/admin",kind:"check",schema:"feedback",check};
    const fetch=vi.fn(async()=>Response.json({error},{status:409}));
    vi.stubGlobal("fetch",fetch);
    const failure=await api.patch<never>("/entries/item?collection=feedback",{expectedVersion:1,data:{}}).catch((error:ApiError)=>error);
    expect(fetch).toHaveBeenCalledOnce();
    expect(failure).toMatchObject({status:409,body:{error}});
    expect(failure.message).toMatch(/^The entry does not meet a check of its Schema.* Nothing was saved\. Correct the values the check requires, then save again\.$/);
    expect(failure.message).not.toMatch(/version|no longer match|_mantle_chk_/);
    expect(failure.message.includes(check)).toBe(shown);
  }
});

test("successful writes add no reads and unreadable conflict rows do not cause retries",async()=>{
  const fetch=vi.fn(async(_url:unknown,init?:RequestInit)=>init?.method
    ? Response.json({error:{code:"CONFLICT",message:"Refused."}},{status:409})
    : Response.json({error:{code:"NOT_FOUND",message:"Not visible."}},{status:404}));
  vi.stubGlobal("fetch",fetch);
  await expect(api.delete("/entries/item?collection=notes")).rejects.toMatchObject({status:409,message:expect.stringContaining("could not be read")});
  expect(fetch.mock.calls.map(([,init])=>init?.method??"GET")).toEqual(["DELETE","GET"]);
  fetch.mockReset().mockImplementation(async()=>Response.json({ok:true}));
  expect(await api.patch("/entries/item?collection=notes",{})).toEqual({ok:true});
  expect(fetch).toHaveBeenCalledOnce();
});
