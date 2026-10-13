/** Independent native output and query-count oracle shared by SQLite, PostgreSQL and actual D1. */
export async function verifyPaging(pages: Record<string, Function>, db: unknown, native: (sql: string) => Promise<any[]>, counted: () => number, pg: boolean) {
  const caller = {kind:"user",subject:"a",role:null,scopes:[],credential:"api-key",credentialId:null,clientId:null} as const;
  const check = (yes: boolean, message: string) => {if (!yes) throw Error(message);};
  for (const name of ["ordered", "mixed", "grouped", "grouped-time", "window-groups", "joined"]) {
    let expected = await native((name === "ordered" || name === "mixed") ? `SELECT id FROM positions WHERE owner='a' AND session='s' ORDER BY ${name === "mixed" ? "block DESC" : "block"},position,id` : name === "joined" ? `SELECT id FROM positions WHERE owner='a' ORDER BY at DESC,id ${pg?"DESC":"ASC"}` : name === "grouped" ? "SELECT day,count(*) AS total FROM positions WHERE owner='a' GROUP BY day ORDER BY day DESC" : `SELECT day,count(*) AS total FROM positions WHERE owner='a' ${name === "window-groups" ? "AND id <> '0000'" : ""} GROUP BY day ORDER BY max(at) DESC,day ${pg?"DESC":"ASC"}`);
    if (name === "grouped" || (name === "grouped-time" || name === "window-groups")) expected = expected.map(row=>({...row,day:pg?row.day instanceof Date?row.day.toISOString().slice(0,10):String(row.day).slice(0,10):new Date(row.day*86400000).toISOString().slice(0,10)}));
    for (const limit of [1,2,200]) {
      let cursor: string|undefined, roundtrips=0; const got: any[]=[];
      do {const before=counted();const page=await pages[name]!(db,caller,(name==="ordered"||name==="mixed")?{session:"s"}:{},{limit,cursor});check(counted()===before+1,"one SELECT per page");got.push(...page.rows);cursor=page.nextCursor;check(++roundtrips<1000,"finite cursor walk");} while(cursor);
      check(JSON.stringify(got.map(row=>name==="ordered"||name==="mixed"||name==="joined"?row.id:row.day))===JSON.stringify(expected.map(row=>name==="ordered"||name==="mixed"||name==="joined"?row.id:row.day)),`${name} native order / tenant rows`);
      if (name === "grouped" || name === "window-groups") check(got.every((row,i)=>Number(row.total)===Number(expected[i].total)),"group counts exclude other tenant and preserve window filter");
      if (name === "joined") check(got.every(row=>row.latest_id==="0500"),"singleton join source excludes other tenant");
      check(got.every(row=>!Object.keys(row).some(k=>k.startsWith("_k"))),"hidden keys removed");
    }
  }
  const one=await pages.lookup!(db,caller,{id:"0000"},{limit:1});
  check(one.rows.length===1&&one.rows[0].at==="2026-10-13T00:00:00.123456Z","singleton temporal wire precision");
  check((await pages.lookup!(db,caller,{id:"other"})).rows.length===0,"singleton tenant isolation");
  check((await pages.singleton!(db,{kind:"anonymous"},{},{limit:1})).rows[0].value==="constant","no-FROM singleton source");
  const first=await pages.ordered!(db,caller,{session:"s"},{limit:1});
  const original=JSON.parse(decodeURIComponent(first.nextCursor));
  for(const bad of ["%",JSON.stringify([]),encodeURIComponent(JSON.stringify([...original.slice(0,-1),"views/grouped"])),encodeURIComponent(JSON.stringify([0,"wrong",original[2],original[3]])),encodeURIComponent(JSON.stringify([null,...original.slice(1)])),encodeURIComponent(JSON.stringify(original.slice(1)))]) {
    await native("UPDATE sessions SET owner='b' WHERE id='s' RETURNING id");
  check((await pages["window-groups"]!(db,caller,{})).rows.length===0,"PK join retains parent tenant policy");
  const before=counted();let failed=false;try{await pages.ordered!(db,caller,{session:"s"},{cursor:bad});}catch(e){failed=(e as any).code==="INPUT_VALIDATION_FAILED";}check(failed&&counted()===before,"invalid cursor before SELECT");
  }
  await native("UPDATE sessions SET owner='b' WHERE id='s' RETURNING id");
  check((await pages["window-groups"]!(db,caller,{})).rows.length===0,"PK join retains parent tenant policy");
  const before=counted();let failed=false;try{await pages.lookup!(db,caller,{id:"0000"},{cursor:first.nextCursor});}catch(e){failed=(e as any).code==="INPUT_VALIDATION_FAILED";}check(failed&&counted()===before,"singleton rejects cursor before SELECT");
}
export function pagingSeed(pg:boolean):string {
  const rows=Array.from({length:501},(_,i)=>`('${String(i).padStart(4,"0")}',1,${pg?"now(),now()":"0,0"},'a','s',${Math.floor(i/4)},${i%2},${pg?"DATE '2026-10-13' + "+i%7:20739+i%7},${pg?`TIMESTAMPTZ '2026-10-13T00:00:00.123456Z' + INTERVAL '${i} microseconds'`:1791849600123456+i})`);
  rows.push(`('other',1,${pg?"now(),now()":"0,0"},'b','s',0,0,${pg?"DATE '2026-10-13'":"20739"},${pg?"TIMESTAMPTZ '2026-10-13T00:00:01.123456Z'":"1791849601123456"})`);
  return `INSERT INTO sessions(id,version,created_at,updated_at,owner,label) VALUES ('s',1,${pg?"now(),now()":"0,0"},'a','session'); INSERT INTO positions(id,version,created_at,updated_at,owner,session,block,position,day,at) VALUES ${rows.join(",")}`;
}
