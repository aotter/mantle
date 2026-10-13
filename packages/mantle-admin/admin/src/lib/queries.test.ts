import { expect, test } from "vitest";
import { cursorPageHref, entriesQueryArgsFromSearch, entryLandingChildQueryOptions } from "./queries";
import type { EntryEditorPayload } from "./types";

test("collection navigation maps its filters to the first-page entries query", () => {
  expect(entriesQueryArgsFromSearch("posts", "?status=published&filter_field=kind&filter_value=news")).toMatchObject({
    collectionName: "posts",
    status: "published",
    filterField: "kind",
    filterValue: "news",
    searchTerm: "",
    sortField: "updatedAt",
    sortDirection: "desc",
    cursorDirection: "forward",
  });
});

test("native entry paging sends only the latest cursor and Previous revisits the opaque URL stack",()=>{
  const query=new URLSearchParams({search:"literal%_",parent:"parent",direction:"asc"});
  expect(cursorPageHref("/admin/c/notes",query)).toBeUndefined();
  const second=new URL(cursorPageHref("/admin/c/notes",query,"cursor:a")!,"https://app.test");
  const third=new URL(cursorPageHref(second.pathname,second.searchParams,"cursor:b")!,second);
  expect(third.searchParams.getAll("cursor")).toEqual(["cursor:a","cursor:b"]);
  expect(entriesQueryArgsFromSearch("notes",third.searchParams)).toMatchObject({cursor:"cursor:b",cursorDirection:"forward",searchTerm:"literal%_"});
  const previous=new URL(cursorPageHref(third.pathname,third.searchParams)!,third);
  expect(previous.searchParams.getAll("cursor")).toEqual(["cursor:a"]);
  expect(previous.searchParams.get("parent")).toBe("parent");
  expect(previous.searchParams.get("cursor_direction")).toBeNull();
  const first=new URL(cursorPageHref(previous.pathname,previous.searchParams)!,previous);
  expect(first.searchParams.has("cursor")).toBe(false);
  expect(first.searchParams.get("search")).toBe("literal%_");
  expect(query.has("cursor")).toBe(false);
});

test("entry landing prefetches the first folded child with the same scoped list key", () => {
  const payload = {
    collection: { name: "organizations" },
    entry: { id: "org-1" },
    related: [
      {
        collection: {
          name: "references",
          parent: null,
        },
        relationship: { kind: "field", childField: "organizationId", parentValue: "org-1" },
      },
      {
        collection: {
          name: "projects",
          parent: { collection: "organizations", parentField: "id", childField: "organizationId" },
        },
        relationship: { kind: "field", childField: "organizationId", parentValue: "org-1" },
      },
    ],
  } as EntryEditorPayload;

  expect(entryLandingChildQueryOptions(payload)?.queryKey).toEqual([
    "entries", "projects", "all", "", "no-filter", "no-value",
    "organizationId", "org-1", "updatedAt", "desc", "first", "forward",
  ]);
});

test("translation badges batch one authorized page per schema and editor composition uses raw data", async () => {
  const { vi } = await import("vitest");
  const { queryClient } = await import("../app/query-client");
  const { entriesQueryOptions, composeEntry } = await import("./queries");
  const parent = { name: "posts", title: "Posts", description: null, lifecycle: "publishing", exportFields: ["slug", "title"], hasTranslations: true, localized: false, schema: {type:"object",properties:{slug:{type:"string"},title:{type:"string"}}} };
  const child = { ...parent, name: "translations", hasTranslations: false, localized: true, translates: {parent:"posts",on:"slug"}, parent:{collection:"posts",parentField:"slug",childField:"slug"}, schema:{type:"object",properties:{slug:{type:"string"},title:{type:"string"},locale:{type:"string"}}} };
  const rows = Array.from({length:50},(_,i)=>({id:String(i),collection:"posts",locale:null,status:"published",version:1,updated_at:1,data:{slug:"s"+i,title:"Post "+i}}));
  queryClient.clear();
  queryClient.setQueryData(["collection-metadata"], {collections:[parent],allCollections:{posts:parent,translations:child}});
  const urls: URL[] = [];
  vi.stubGlobal("fetch", async (path:string) => {
    const url = new URL(path,"https://fixture.test"); urls.push(url);
    if (url.searchParams.get("collection")==="posts") return Response.json({items:rows,next_cursor:null});
    return Response.json({items:[{...rows[0],id:"translated",collection:"translations",locale:"ja",data:{slug:"s0",title:"Japanese",locale:"ja"}}],next_cursor:null});
  });
  try {
    const result = await entriesQueryOptions({collectionName:"posts",searchTerm:"",sortField:"updatedAt",sortDirection:"desc",cursorDirection:"forward"}).queryFn();
    expect(urls).toHaveLength(2);
    expect(JSON.parse(urls[1]!.searchParams.get("filter_values")!)).toHaveLength(50);
    expect(result.items[0]).toMatchObject({title:"Post 0",translation_locales:["ja"]});
    expect(result.items[0]!.data_preview).toBeUndefined();
    expect(result.items[1]!.translation_locales).toEqual([]);
    const document = {collection:{...parent,translates:null,uiSchema:null},entry:rows[0]!} as import("./types").EntryDocument;
    const editor = await composeEntry(document);
    expect(editor.entry).toBe(rows[0]);
    expect(editor.related[0]).toMatchObject({collection:{name:"translations"},relationship:{kind:"translation",parentField:"slug",childField:"slug",parentValue:"s0"},entries:[{id:"translated"}]});
    expect(urls[2]!.searchParams.get("filter_field")).toBe("slug");
    expect(urls[2]!.searchParams.get("filter_value")).toBe("s0");
  } finally { vi.unstubAllGlobals(); queryClient.clear(); }
});
