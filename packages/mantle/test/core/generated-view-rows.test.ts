// @ts-nocheck Differential generated-code checks against the existing generic View contract.
import { expect, it } from 'vitest';
import ts from 'typescript';
import { emitViewRows } from '../../src/cli/emitViewRows.js';
import { d1Dialect } from '../../src/d1/dialect.js';
import { postgresDialect } from '../../src/postgres/dialect.js';
import { NATIVE_OUTPUT_TYPES, compileSql } from '../../src/spec/index.js';
import { createStore } from '../../src/core/store/createStore.js';
import { decodeCursor } from '../../src/core/store/cursor.js';
const types = ['text','integer','int4','int8','real','float8','bool','json','numeric(12,2)','date','timestamptz','geo'];
const fields = Object.fromEntries(types.map((t,i)=>['f'+i,t]));
const keys = [...Object.keys(fields),'created_at','unknown','__proto__'];
const columns = Object.fromEntries(keys.filter(k=>k!=='unknown').map(k=>[k,{schema:'events',field:k}]));
const schemas = {events:{name:'Events',fields:{...fields,['__proto__']:'json'},names:{f10:'startsAt'}}};
const select = {SelectStmt:{targetList:keys.map(name=>({ResTarget:{name,val:{ColumnRef:{fields:[{String:{sval:name}}]}}}})),fromClause:[{RangeVar:{relname:'events',mantle:'table'}}]}};
const view = {stmts:[select],columns,inputs:{},surface:'internal'};
const plan = {views:{['__proto__']:view},schemas};
function generated(p=plan) {
 const js=ts.transpileModule(emitViewRows(p),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
 const exports={};new Function('exports',js)(exports);return exports.viewRows;
}
function generic(row,v,codec) {
 return Object.fromEntries(Object.entries(row).map(([k,value])=>{
  const c=v.columns&&Object.hasOwn(v.columns,k)?v.columns[k]:undefined,def=c&&schemas[c.schema];
  return def?[k===c.field?def.names?.[c.field]??k:k,codec.decode(Object.hasOwn(def.fields,c.field)?def.fields[c.field]:NATIVE_OUTPUT_TYPES[c.field],value)]:[k,value];
 }));
}
it('preserves all dialect codecs, NULL, unknown values, renames and prototype keys',()=>{
 const fn=generated()['__proto__'];
 for(const dialect of [d1Dialect,postgresDialect()]) {
  const codec=dialect.codec,wire=['text',3,4,5,1.25,2.5,true,{x:[1]},'12.34','2026-10-11','2026-10-11T01:02:03.456789Z','geo'];
  const row=Object.fromEntries(types.map((t,i)=>['f'+i,t==='geo'?wire[i]:codec.encode(t,wire[i])]));
  Object.assign(row,{created_at:codec.encode('timestamptz',wire[10]),unknown:{untouched:true}});
  Object.defineProperty(row,'__proto__',{value:codec.encode('json',{safe:true}),enumerable:true,configurable:true});
  if(dialect!==d1Dialect) {row.f7=wire[7];Object.defineProperty(row,'__proto__',{value:{safe:true},enumerable:true});}
  expect(fn(row,codec)).toEqual(generic(row,view,codec));
  expect(Object.getPrototypeOf(fn(row,codec))).toBe(Object.prototype);
  const empty=Object.fromEntries(keys.map(k=>[k,null]));expect(fn(empty,codec)).toEqual(generic(empty,view,codec));
  expect(fn({...row,_k0:123,private_extra:'hidden'},codec)).toEqual(generic(row,view,codec));
 }
});
it('preserves duplicate declared names and decode failures; unresolved output shape stays generic',()=>{
 const collision={...view,stmts:[{SelectStmt:{targetList:['f7','meta'].map(name=>({ResTarget:{name}}))}}],columns:{f7:columns.f7}};
 const p={views:{collision},schemas:{events:{...schemas.events,names:{f7:'meta'}}}};
 const fn=generated(p).collision;
 expect(fn({f7:'{"a":1}',meta:'last'},d1Dialect.codec)).toEqual({meta:'last'});
 const refusing={decode:(type,value)=>{if(type==='json')throw Error('decode refusal');return value;}};
 expect(()=>fn({f7:'invalid-json',meta:'last'},refusing)).toThrow('decode refusal');
 const unnamed={stmts:[{SelectStmt:{targetList:[{ResTarget:{val:{FuncCall:{}}}}]}}]};
 expect(Object.keys(generated({views:{unnamed},schemas}))).toEqual([]);
 expect(emitViewRows(plan)).toBe(emitViewRows(plan));
});
it('decodes each visible row once while preserving the raw hidden cursor and generic fallback',async()=>{
 const source=await compileSql('SELECT f10 FROM events ORDER BY f10',{schemas,inputs:{},kind:'view'});expect(source.ok).toBe(true);
 const v={ir:source.plan.stmts,inputs:{},columns:{f10:columns.f10}},p={views:{dates:{...v,stmts:v.ir}},schemas};
 let decoded=0;const fn=generated(p).dates,raw=d1Dialect.codec.encode('timestamptz','2026-10-11T01:02:03.456789Z');
 const executor={maxBindings:100,select:async()=>[{f10:raw,_k0:raw,_k1:'a'},{f10:raw+1,_k0:raw+1,_k1:'b'}],apply:async()=>[]};
 const deps={schemas,dialect:d1Dialect,executor,now:()=>0,newId:()=> 'x'};
 const fallback=createStore({...deps,views:{dates:v}}),optimized=createStore({...deps,views:{dates:{...v,row:(r,codec)=>{decoded++;return fn(r,codec);}}}});
 const expected=await fallback.view('dates',{limit:1});expect(await optimized.view('dates',{limit:1})).toEqual(expected);
 expect(decoded).toBe(1);expect(decodeCursor('view:dates',expected.nextCursor)).toEqual([raw,'a']);
});
