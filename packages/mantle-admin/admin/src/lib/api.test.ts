import { afterEach, expect, test, vi } from "vitest";
import { api, downloadAdminFile, csvCell } from "./api";

afterEach(() => vi.unstubAllGlobals());

test("client CSV retains filters, formula safety and cursor pages without a server export route", async () => {
  const urls: string[] = [];
  const click = vi.fn(), remove = vi.fn();
  const link = { href: "", download: "", click, remove };
  vi.stubGlobal("window", { location: { href: "https://site.test/admin", origin: "https://site.test" } });
  vi.stubGlobal("document", { createElement: () => link, body: { append: vi.fn() } });
  const create = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:export");
  vi.stubGlobal("fetch", async (url: string) => {
    urls.push(url);
    return Response.json({ items: [{ id: String(urls.length), status: null, version: 1, updated_at: 1, data: { name: urls.length === 1 ? "=formula" : "Ada, \"Lovelace\"" } }], next_cursor: urls.length === 1 ? "opaque:next" : null });
  });
  try {
    await downloadAdminFile("/admin/api/entries/export?collection=items&status=draft&cursor=old", ["id", "name"]);
    expect(urls).toEqual(["/admin/api/entries?collection=items&status=draft&limit=500", "/admin/api/entries?collection=items&status=draft&limit=500&cursor=opaque%3Anext"]);
    const blob = create.mock.calls[0]![0] as Blob;
    expect([...new Uint8Array(await blob.arrayBuffer()).slice(0, 3)]).toEqual([239, 187, 191]);
    expect(await blob.text()).toBe("id,name\r\n1,'=formula\r\n2,\"Ada, \"\"Lovelace\"\"\"\r\n");
    expect(click).toHaveBeenCalledOnce();
    expect(link.download).toBe("items.csv");
    expect(remove).toHaveBeenCalledOnce();
  } finally { create.mockRestore(); }
});

test("failed later pages and foreign exports produce no partial file", async () => {
  vi.stubGlobal("window", { location: { href: "https://site.test/admin", origin: "https://site.test" } });
  const create = vi.spyOn(URL, "createObjectURL");
  const fetch = vi.fn().mockResolvedValueOnce(Response.json({ rows: [{ name: "Ada" }], nextCursor: "second" })).mockResolvedValueOnce(Response.json({error:{code:"FORBIDDEN",message:"Denied"}},{status:403}));
  vi.stubGlobal("fetch",fetch);
  try {
    await expect(downloadAdminFile("/admin/api/views/people/export")).rejects.toMatchObject({status:403});
    expect(create).not.toHaveBeenCalled();
    await expect(downloadAdminFile("https://other.test/admin/api/views/people/export")).rejects.toThrow("Admin download URL");
    await expect(downloadAdminFile("/oauth/consents/revoke")).rejects.toThrow("Admin download URL");
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(csvCell(" \t@formula")).toBe("' \t@formula");
    expect(csvCell(-3)).toBe("-3");
  } finally { create.mockRestore(); }
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
