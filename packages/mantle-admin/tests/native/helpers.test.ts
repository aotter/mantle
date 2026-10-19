import { sdkFixtureCaller as fixtureCaller } from "../../../mantle/tests/apps/fixtures.js";
import {test,expect} from "bun:test";
import {nativePage,nativeText,nativeStatistics,entriesQuery,type NativeAdapter,type NativePageMode,type NativeCollection} from "../../src/server/native.js";
import type {Caller} from "@aotter/mantle/contracts";
const caller:Caller=fixtureCaller({kind:"user",subject:"tenant-a",role:"admin", admin: true,scopes:[],credential:"session",credentialId:null,clientId:null});
test("native page uses Core tuple cursor, preserves binding positions and caps effective page",async()=>{
 const reads:{sql:string,values:unknown[]}[]=[];
 const adapter:NativeAdapter<null>={sqlite:false,values:{},param:n=>"$"+n,escapeLike:s=>s.replace(/[%_]/g,"\\$&"),read:(_db,sql,values)=>{reads.push({sql,values});return Array.from({length:3},(_,i)=>({_k0:i,_k1:"id"+i,_k2:i%2===0,title:"row"+i}));}};
 const mode:NativePageMode={marker:"$9999",binds:[{k:"uid"},{k:"input",name:"title"}],keys:3,first:{prefix:"FIRST",extra:[]},next:{prefix:"NEXT",extra:[0,1,2]},tail:" LIMIT $9999",eq:{enabled:"enabled=$9999",category:"category=$9999"},search:"title LIKE $9999"};
 const spec={path:"admin/views/posts",cap:2,cursorKinds:["int","text","bool"]as const,caller:mode,trusted:mode},input={title:"x"},match={filters:{enabled:true,category:"news"},search:"100%"};
 const result=await nativePage(spec,adapter,null,caller,input,{limit:50,match});
 expect(result.rows).toHaveLength(2);expect(result.rows[0]).not.toHaveProperty("_k0");expect(result.nextCursor).toBeDefined();
 expect(reads[0]).toEqual({sql:"FIRST WHERE (enabled=$3) AND (category=$4) AND (title LIKE $5) LIMIT $6",values:["tenant-a","x",true,"news","%100\\%%",3]});
 await nativePage(spec,adapter,null,caller,input,{cursor:result.nextCursor,match});
 expect(reads[1]).toEqual({sql:"NEXT AND (enabled=$6) AND (category=$7) AND (title LIKE $8) LIMIT $9",values:["tenant-a","x",1,"id1",false,true,"news","%100\\%%",3]});
 for(const [who,selection]of[[fixtureCaller({...caller,subject:"tenant-b"}),match],[caller,{...match,filters:{enabled:false,category:"news"}}]]as const){await expect(nativePage(spec,adapter,null,who,input,{cursor:result.nextCursor,match:selection})).rejects.toMatchObject({code:"INPUT_VALIDATION_FAILED",path:"admin/views/posts/cursor"});}expect(reads).toHaveLength(2);
 const forged=encodeURIComponent(JSON.stringify([1,"id1",JSON.stringify([spec.path,caller,input,match.filters,match.search])]));await expect(nativePage(spec,adapter,null,caller,input,{cursor:forged,match})).rejects.toMatchObject({path:"admin/views/posts/cursor"});expect(reads).toHaveLength(2);
});
test("native helpers reject NUL JSON keys, bucket overflow and intersect scoped batch filters",async()=>{
 expect(()=>nativeText({["bad\0key"]:"value"})).toThrow();let nested:unknown="fine";for(let i=0;i<12000;i++)nested={nested};expect(()=>nativeText(nested)).not.toThrow();
 let reads=0;const adapter:NativeAdapter<null>={sqlite:true,values:{},param:n=>"?"+n,escapeLike:s=>s,read:()=>{reads++;return[];}};
 await expect(nativeStatistics({posts:{statistics:{time:"created_at",subtype:"NULL",rowsAlias:{name:"_statistics",sql:"_statistics"}}} as NativeCollection},adapter,null,caller,"posts",{from:Number.MAX_SAFE_INTEGER-1000,to:Number.MAX_SAFE_INTEGER,bucketMs:1000})).rejects.toMatchObject({code:"INPUT_VALIDATION_FAILED"});expect(reads).toBe(0);
 const options={path:"admin/entries",orderFields:{updatedAt:"updated_at"},publishing:false,sqlite:true,field:(name:string,raw:string)=>({column:name,value:raw})};
 expect(entriesQuery(new URLSearchParams({filter_field:"tenant",filter_values:'["a","b"]',scope_field:"tenant",scope_value:"a"}),options)?.match?.filters).toEqual({tenant:"a"});
 expect(entriesQuery(new URLSearchParams({filter_field:"tenant",filter_values:'["b"]',scope_field:"tenant",scope_value:"a",sort:"invalid"}),options)).toBeNull();
 expect(()=>entriesQuery(new URLSearchParams({filter_field:"tenant",filter_values:JSON.stringify(Array.from({length:51},(_,i)=>i))}),options)).toThrow();
});
