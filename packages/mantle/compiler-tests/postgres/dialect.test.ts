import {expect,it} from "vitest";
import {loadModule,parseSync} from "libpg-query";
import postgres from "postgres";
import {print} from "../../src/build/postgres/print.js";
const PG_URL=process.env.MANTLE_PG_URL;
it.skipIf(!PG_URL)("nested operands including AT TIME ZONE keep PostgreSQL native semantics",async()=>{
 await loadModule();const db=postgres(PG_URL!,{max:1,onnotice:()=>{}}),schema="printer_"+crypto.randomUUID().replaceAll("-","");
 try{
  await db.unsafe(`CREATE SCHEMA ${schema}`);await db.unsafe(`SET search_path TO ${schema}`);await db.unsafe("SET TIME ZONE 'UTC'");
  for(const q of ["SELECT (timestamptz '2026-01-01' AT TIME ZONE ('UT' || 'C'))::text AS v","SELECT (('2026-01-01 00:00' || '') ::timestamp AT TIME ZONE 'UTC') < now() AS v","SELECT 5 BETWEEN 0 AND (2 + 3) AS v","SELECT (1 = 1) IN (true) AS v","SELECT 'ab' LIKE ('a' || '%') AS v"]){
   const rendered=print((parseSync(q) as any).stmts[0].stmt);expect([q,(await db.unsafe(rendered))[0]]).toEqual([q,(await db.unsafe(q))[0]]);
  }
 }finally{try{await db.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);}finally{await db.end();}}
});
