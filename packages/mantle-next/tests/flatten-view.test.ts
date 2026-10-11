import { expect, test } from "bun:test";
import { flattenView } from "../src/domain/flattenView.js";
import { Client } from "pg";
import { print } from "../../mantle/dist/postgres/print.js";
import { generateFromSources } from "../src/infrastructure/generate.js";
import { readFile } from "node:fs/promises";
import { compilePlan } from "@aotter/mantle/spec";
import * as pgCompiler from "@aotter/mantle/postgres/compile";
import { postgresDialect } from "../../mantle/dist/postgres/dialect.js";
import { compileProgram } from "../../mantle/dist/core/sql/compile.js";
import { lowerPlan } from "../../mantle/dist/core/sql/lowered.js";

const column = (...names: string[]) => ({ ColumnRef: { fields: names.map(sval => ({ String: { sval } })) } });
const base = () => ({ SelectStmt: {
  targetList: [{ ResTarget: { val: column("n", "title") } }],
  fromClause: [{ RangeSubselect: { alias: { aliasname: "n" }, subquery: { SelectStmt: {
    targetList: ["id", "title"].map(name => ({ ResTarget: { val: column(name) } })),
    fromClause: [{ RangeVar: { relname: "notes", mantle: "system", inh: true, relpersistence: "p" } }],
    whereClause: { A_Expr: { kind: "AEXPR_OP", name: [{ String: { sval: "=" } }], lexpr: column("notes", "owner"), rexpr: { ParamRef: { number: 1 } } } },
    op: "SETOP_NONE", limitOption: "LIMIT_OPTION_DEFAULT",
  } } } }],
  whereClause: { NullTest: { arg: column("n", "title"), nulltesttype: "IS_NOT_NULL" } },
} });
const schemas = { notes: { fields: { title: "text", owner: "text", expiry: "bigint", status: "text" }, scope: "owner" } };

test("identity wrapper flatten preserves source, policy binds and AND grouping", () => {
  const ast = base(), saved = structuredClone(ast);
  const output = flattenView(ast, schemas);
  expect(output).not.toBe(ast);
  expect(ast).toEqual(saved);
  expect(output.SelectStmt.fromClause[0].RangeVar.alias.aliasname).toBe("n");
  const args = output.SelectStmt.whereClause.BoolExpr.args;
  expect(args[0]).toEqual(ast.SelectStmt.whereClause);
  expect(args[1].A_Expr.lexpr).toEqual(column("n", "owner"));
  expect(args[1].A_Expr.rexpr).toEqual({ ParamRef: { number: 1 } });
});

test.skipIf(!process.env.MANTLE_NEXT_BUN_PG_URL)("official PG preserves rows, OIDs, ordering and policy negative control", async () => {
  const db = new Client({ connectionString: process.env.MANTLE_NEXT_BUN_PG_URL });
  await db.connect();
  try {
    await db.query("BEGIN");
    await db.query("CREATE TEMP TABLE notes(id text, title text, owner text, expiry bigint, status text)");
    await db.query("INSERT INTO notes VALUES ('a','same','alice',NULL,'published'),('b','same','alice',100,'published'),('c',NULL,'alice',101,'draft'),('d','same','bob',NULL,'published'),('e',NULL,'alice',101,'published')");
    const ast: any = base();
    const inner = ast.SelectStmt.fromClause[0].RangeSubselect.subquery.SelectStmt;
    inner.targetList.push(...["expiry", "status"].map(name => ({ResTarget:{val:column(name)}})));
    const eq = (left: any, right: any, op = "=") => ({A_Expr:{kind:"AEXPR_OP",name:[{String:{sval:op}}],lexpr:left,rexpr:right}});
    inner.whereClause = {BoolExpr:{boolop:"AND_EXPR",args:[inner.whereClause,
      {BoolExpr:{boolop:"OR_EXPR",args:[{NullTest:{arg:column("notes","expiry"),nulltesttype:"IS_NULL"}},eq(column("notes","expiry"),{ParamRef:{number:2}},">")]}},
      eq(column("notes","status"),{A_Const:{sval:{sval:"published"}}}),
    ]}};
    ast.SelectStmt.whereClause = {BoolExpr:{boolop:"OR_EXPR",args:[{NullTest:{arg:column("n","title"),nulltesttype:"IS_NULL"}},eq(column("n","title"),{A_Const:{sval:{sval:"same"}}})]}};
    ast.SelectStmt.targetList = ["id","title"].map(name => ({ResTarget:{val:column("n",name)}}));
    ast.SelectStmt.sortClause = ["title","id"].map(name=>({SortBy:{node:column("n",name),sortby_dir:"SORTBY_DESC",sortby_nulls:"SORTBY_NULLS_LAST"}}));
    ast.SelectStmt.limitCount = {A_Const:{ival:{ival:3}}};
    const flat = flattenView(ast, schemas);
    expect(flat).not.toBe(ast);
    const query = (tree: any, values: any[]) => db.query({text:print(tree),values,types:{getTypeParser:()=>(v: string)=>v}});
    for (const owner of ["alice","bob",null]) {
      const a = await query(ast,[owner,100]), b = await query(flat,[owner,100]);
      expect(b.rows).toEqual(a.rows);
      expect(b.fields.map(f=>[f.name,f.dataTypeID,f.dataTypeModifier])).toEqual(a.fields.map(f=>[f.name,f.dataTypeID,f.dataTypeModifier]));
      if(owner === "alice") expect(a.rows.map(r=>r.id)).toEqual(["a","e"]);
      if(owner === null) expect(a.rows).toEqual([]);
    }
    const unsafe = structuredClone(ast);
    unsafe.SelectStmt.fromClause[0].RangeSubselect.subquery.SelectStmt.whereClause.BoolExpr.args.shift();
    unsafe.SelectStmt.fromClause[0].RangeSubselect.subquery.SelectStmt.whereClause.BoolExpr.args[0].BoolExpr.args[1].A_Expr.rexpr.ParamRef.number = 1;
    const leaked = await query(unsafe,[100]);
    expect(leaked.rows.some(r=>r.id === "d")).toBe(true);
    const aggregate = structuredClone(ast);
    delete aggregate.SelectStmt.sortClause; delete aggregate.SelectStmt.limitCount;
    aggregate.SelectStmt.targetList = [{ResTarget:{name:"count",val:{FuncCall:{funcname:[{String:{sval:"count"}}],agg_star:true}}}}];
    for(const owner of ["alice","nobody"]) expect((await query(flattenView(aggregate,schemas),[owner,100])).rows).toEqual((await query(aggregate,[owner,100])).rows);
  } finally { await db.query("ROLLBACK"); await db.end(); }
});

test("uncertain wrappers and private outer columns retain the exact original AST", () => {
  const changes = [
    (a: any) => a.SelectStmt.withClause = {ctes:[]},
    (a: any) => a.SelectStmt.lockingClause = [],
    (a: any) => a.SelectStmt.targetList[0].ResTarget.val = column("n", "owner"),
    (a: any) => a.SelectStmt.targetList[0].ResTarget.val = column("title"),
    (a: any) => a.SelectStmt.fromClause[0].RangeSubselect.lateral = true,
    (a: any) => a.SelectStmt.fromClause[0].RangeSubselect.alias.colnames = [{String:{sval:"renamed"}}],
    (a: any) => a.SelectStmt.fromClause[0].RangeSubselect.subquery.SelectStmt.limitCount = {A_Const:{ival:{ival:1}}},
    ...["distinctClause","groupClause","sortClause","windowClause","lockingClause"].map(key=>(a: any)=>a.SelectStmt.fromClause[0].RangeSubselect.subquery.SelectStmt[key]=[]),
    (a: any) => a.SelectStmt.fromClause.push({RangeVar:{relname:"other"}}),
    (a: any) => a.SelectStmt.fromClause[0].RangeSubselect.subquery.SelectStmt.targetList[0].ResTarget.val = {A_Const:{ival:{ival:1}}},
    (a: any) => a.SelectStmt.fromClause[0].RangeSubselect.subquery.SelectStmt.targetList[0].ResTarget.val = {ColumnRef:{fields:[{A_Star:{}}]}},
    (a: any) => a.SelectStmt.fromClause[0].RangeSubselect.subquery.SelectStmt.targetList[0].ResTarget.name = "renamed",
    (a: any) => a.SelectStmt.fromClause[0].RangeSubselect.subquery.SelectStmt.fromClause[0].RangeVar.mantle = "cte",
    (a: any) => a.SelectStmt.targetList[0].ResTarget.val = {SubLink:{subselect:base()}},
    (a: any) => a.SelectStmt.targetList[0].ResTarget.val = {ColumnRef:{fields:[{String:{sval:"n"}},{A_Star:{}}]}},
  ];
  for (const change of changes) { const ast = base(); change(ast); expect(flattenView(ast, schemas)).toBe(ast); }
  const ast = base(); expect(flattenView(ast, {})).toBe(ast);
});

test.skipIf(!process.env.MANTLE_NEXT_BUN_PG_URL)("canonical policy compiler preserves all View modes and raw-only lowered metadata", async () => {
  const source = await readFile(new URL("apps/purchase.yaml", import.meta.url),"utf8");
  const compiled = await compilePlan({sources:[{sourceId:"purchase.yaml",text:source}]},pgCompiler);
  if(!compiled.ok) throw Error(JSON.stringify(compiled.diagnostics));
  const plan = compiled.plan, dialect = postgresDialect();
  const view = plan.views["purchase-list"]!;
  // Add the compiler's supported TTL/publishing metadata to the real compiled fixture.
  const originalSchema = plan.schemas.purchase_requests!;
  const schema = {...originalSchema,ttl:"submittedat",ttlSeconds:0,publishing:true};
  const known = {...plan.schemas,purchase_requests:schema};
  const db = new Client({connectionString:process.env.MANTLE_NEXT_BUN_PG_URL}); await db.connect();
  try {
    await db.query("BEGIN");
    await db.query("CREATE TEMP TABLE purchase_requests(id text,version integer,created_at timestamptz,updated_at timestamptz,author_id text,status text,ownerid text,requestnumber text,title text,amount numeric,approved boolean,sortbucket integer,requestedunits bigint,submittedat timestamptz,neededon date,payload jsonb)");
    await db.query("INSERT INTO purchase_requests(id,ownerid,title,submittedat,status) VALUES ('a','alice','same',NULL,'published'),('b','alice','same','2000-01-01','published'),('c','alice',NULL,'2100-01-01','draft'),('d','bob','same',NULL,'published')");
    for(const mode of ["caller","trusted","public"] as const) {
      const [raw] = compileProgram(view.stmts,{dialect,schemas:known,inputs:view.inputs,kind:"view",mode});
      const snapshot = structuredClone(raw!), flattened = flattenView(raw!.ast,known);
      expect(flattened).not.toBe(raw!.ast); expect(raw).toEqual(snapshot);
      const values = raw!.binds.map(b=>b.k==="uid"?"alice":b.k==="cutoff"?"2026-01-01T00:00:00Z":null);
      const execute = (ast:any)=>db.query({text:dialect.print!(ast,known),values,types:{getTypeParser:()=>(v:string)=>v}});
      const a = await execute(raw!.ast), b = await execute(flattened);
      expect(b.rows).toEqual(a.rows); expect(b.fields.map(f=>[f.name,f.dataTypeID,f.dataTypeModifier])).toEqual(a.fields.map(f=>[f.name,f.dataTypeID,f.dataTypeModifier]));
      expect(b.rows.map(r=>r.id)).toEqual(mode==="public"?["a"]:mode==="trusted"?["a","c","d"]:["a","c"]);
    }
    const canonical = lowerPlan(plan,dialect).lowered, saved = structuredClone(canonical);
    for(const [name,modes] of Object.entries(canonical.views)) for(const [mode,statement] of Object.entries(modes)) {
      const v=plan.views[name]!; const [raw]=compileProgram(v.stmts,{dialect,schemas:plan.schemas,inputs:v.inputs,kind:"view",mode:mode as "caller"|"trusted"|"public"});
      const flat=flattenView(raw!.ast,plan.schemas); if(flat!==raw!.ast) Object.assign(statement!,{sql:dialect.print!(flat,plan.schemas)});
      expect({...statement,sql:saved.views[name]![mode as "caller"]!.sql}).toEqual(saved.views[name]![mode as "caller"]!);
    }
    expect(canonical.procedures).toEqual(saved.procedures);
  } finally {await db.query("ROLLBACK");await db.end();}
});

test("both PostgreSQL artifacts flatten raw single-range Views and keep Procedure transactions", async () => {
  const source = await readFile(new URL("apps/purchase.yaml", import.meta.url), "utf8");
  for(const target of ["bun-postgres","cloudflare-postgres"] as const) {
    const result = await generateFromSources({target,sources:{sources:[{sourceId:"purchase.yaml",text:source}]}});
    if(!result.ok) throw Error(JSON.stringify(result.diagnostics));
    const code = result.files["generated.ts"]!;
    expect(code).toContain("FROM purchase_requests AS r WHERE r.ownerid = $1 ORDER BY r.id");
    expect(code).toContain("BEGIN ISOLATION LEVEL SERIALIZABLE");
    expect(code).not.toContain("flattenView");
    expect(code).not.toContain("compileProgram");
  }
});
