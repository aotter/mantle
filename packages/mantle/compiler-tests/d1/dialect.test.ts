import {expect,it} from "vitest";
import {DatabaseSync} from "node:sqlite";
import {loadModule,parseSync} from "libpg-query";
import {print} from "../../src/build/d1/print.js";
import {d1Dialect} from "../../src/build/d1/dialect.js";
import {initialStorageSql} from "../../src/build/d1/storage.js";
import {compileProgram} from "../../src/build/core/sql/compile.js";
import {compileSql} from "../compiler.js";
import {corpus} from "../corpus.js";
import {schemas} from "../schemas.js";
it("the D1 compiler accepts every authored printer corpus item",async()=>{
 const refused:string[]=[];
 for(const item of corpus){const r=await compileSql(item.sql,{schemas,kind:item.kind,inputs:item.inputs??{}});if(!r.ok)refused.push(`${item.id}: ${r.diagnostic.message}`);}
 expect(refused).toEqual([]);
});
it("the policy wrapper prints scope and TTL once and native SQLite uses the declared indexes",async()=>{
 const sql="SELECT i.name,count(o.id) AS n,coalesce(sum(o.qty),0) AS total FROM items i LEFT JOIN orders o ON o.item_id=i.id GROUP BY i.name HAVING count(o.id)>=input.min ORDER BY total DESC,i.name LIMIT 10";
 const r=await compileSql(sql,{schemas,kind:"view",inputs:{min:"int8"}});if(!r.ok)throw Error(r.diagnostic.message);
 const native=print(compileProgram(r.plan.stmts,{schemas,dialect:d1Dialect,kind:"view",mode:"caller",inputs:{min:"int8"}})[0]!.ast);
 expect(native).toMatch(/FROM items WHERE items\.owner = \?1 AND \(items\.expires_at IS NULL OR items\.expires_at > \?2\)/);
 expect(native).toMatch(/FROM orders WHERE orders\.owner = \?1/);expect(native).not.toMatch(/\?4/);
 const sqlite=new DatabaseSync(":memory:");try{
  for(const ddl of initialStorageSql({items:schemas.items!,orders:schemas.orders!}))sqlite.exec(ddl);
  const detail=sqlite.prepare("EXPLAIN QUERY PLAN "+native).all({"1":"o1","2":0,"3":0}).map(row=>row.detail).join(" | ");
  expect(detail).toMatch(/_mantle_ix_items_0/);expect(detail).toMatch(/_mantle_ix_orders_0/);
 }finally{sqlite.close();}
},120000);
it("nested operands print in parentheses and native SQLite evaluates the original expression",async()=>{
 await loadModule();const sqlite=new DatabaseSync(":memory:");try{
  for(const q of ["SELECT 5 BETWEEN 0 AND (5 BETWEEN 1 AND 2) AS v","SELECT 5 BETWEEN 0 AND (5 IN (SELECT 1)) AS v","SELECT 'a' LIKE ('a' IN (SELECT 1)) AS v","SELECT 'ab' LIKE 'a%' ESCAPE ('!' = '!') AS v","SELECT (1 IN (SELECT 1)) BETWEEN 0 AND 0 AS v","SELECT (2 = 2) IS NULL AS v"]){
   const rendered=print((parseSync(q) as any).stmts[0].stmt);expect([q,sqlite.prepare(rendered).get()]).toEqual([q,sqlite.prepare(q).get()]);
  }
 }finally{sqlite.close();}
});
it("a sign before a negative constant never prints --",()=>{
 const stmt=(val:unknown)=>({SelectStmt:{targetList:[{ResTarget:{val}}],limitOption:"LIMIT_OPTION_DEFAULT",op:"SETOP_NONE"}});
 const minus=(rexpr:unknown)=>({A_Expr:{kind:"AEXPR_OP",name:[{String:{sval:"-"}}],rexpr}});
 for(const c of [{ival:{ival:-2}},{fval:{fval:"-2.5"}}])expect(print(stmt(minus({A_Const:c})) as never)).not.toContain("--");
 const sqlite=new DatabaseSync(":memory:");try{
  const truth={SelectStmt:{...stmt({A_Const:{ival:{ival:0}}}).SelectStmt,targetList:[{ResTarget:{name:"true",val:{A_Const:{ival:{ival:0}}}}}],whereClause:{A_Const:{boolval:{boolval:true}}}}};
  expect(sqlite.prepare(print(truth as never)).get()).toEqual({true:0});
 }finally{sqlite.close();}
});
it("literal casts in ORDER BY keep value ordering instead of ordinal ordering",async()=>{
 const refused=await compileSql("SELECT id FROM items ORDER BY +2,id",{schemas,kind:"view",inputs:{}});
 expect(refused.ok).toBe(false);if(refused.ok)throw Error("unexpected signed ordinal");expect(refused.diagnostic.message).toMatch(/a sign over a number/);
 const sqlite=new DatabaseSync(":memory:");try{
  for(const ddl of initialStorageSql({items:schemas.items!}))sqlite.exec(ddl);
  sqlite.exec("INSERT INTO items(id,created_at,owner,stock) VALUES ('a',0,'o1',5),('b',0,'o1',2),('c',0,'o1',9),('d',0,'o1',7)");
  for(const cast of ["CAST('0.2' AS numeric(10,1))","CAST('1970-01-03' AS date)"]){
   const r=await compileSql(`SELECT id FROM (SELECT id,stock FROM items ORDER BY ${cast},id LIMIT 1) s ORDER BY id`,{schemas,kind:"view",inputs:{}});if(!r.ok)throw Error(r.diagnostic.message);
   const c=compileProgram(r.plan.stmts,{schemas,dialect:d1Dialect,kind:"view",inputs:{},mode:"trusted"})[0]!;
   expect([cast,sqlite.prepare(print(c.ast)).all()]).toEqual([cast,[{id:"a"}]]);
  }
 }finally{sqlite.close();}
},120000);
