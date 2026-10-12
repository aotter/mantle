/** One independent client-wire oracle, shared by native SQLite, PostgreSQL and local D1. */
import assert from 'node:assert/strict';
export const cases = [
 ['a',{nested:[1,true]},true],['b',[1,'x'],false],['c','hello',true],['d',42,false],['e',false,true],['f',null,false],['g',undefined,null],
] as const;
export const source=`apiVersion: cms.mantle.aotter.net/v2
kind: Schema
metadata: {name: wire_records}
spec:
  title: Wire records
  lifecycle: operational
  schema: {type: object, properties: {payload: {type: object, nullable: true}, flag: {type: boolean, nullable: true}, quantity: {type: integer, nullable: true}}}
---
apiVersion: cms.mantle.aotter.net/v2
kind: View
metadata: {name: wire-records}
spec:
  surface: public
  input: {type: object, properties: {id: {type: string}}, required: [id], additionalProperties: false}
  sql: 'SELECT id, payload AS "dataAlias", flag AS "enabledAlias", CAST(payload AS text) AS "computedJson", quantity AS "quantityAlias", version AS "versionAlias", CAST(quantity AS text) AS "computedInteger" FROM wire_records WHERE id = input.id ORDER BY id'
---
apiVersion: cms.mantle.aotter.net/v2
kind: Procedure
metadata: {name: echo-native}
spec:
  input: {type: object, additionalProperties: false}
  output: {type: object}
  handler: {ref: app.echoNative}
---
apiVersion: cms.mantle.aotter.net/v2
kind: Trigger
metadata: {name: echo-native-mcp}
spec: {source: {kind: mcp, surface: public}, target: {procedure: echo-native}}
---
apiVersion: cms.mantle.aotter.net/v2
kind: Trigger
metadata: {name: echo-native-http}
spec: {source: {kind: http, method: POST, path: /api/native}, target: {procedure: echo-native}}
---
apiVersion: cms.mantle.aotter.net/v2
kind: Procedure
metadata: {name: read-native}
spec:
  input: {type: object, properties: {id: {type: string}, version: {type: integer}}, required: [id, version], additionalProperties: false}
  output: {type: object}
  handler: {sql: 'UPDATE wire_records SET payload = payload WHERE id = input.id AND version = input.version RETURNING payload, flag'}
---
apiVersion: cms.mantle.aotter.net/v2
kind: Trigger
metadata: {name: read-native-mcp}
spec: {source: {kind: mcp, surface: public}, target: {procedure: read-native}}
---
apiVersion: cms.mantle.aotter.net/v2
kind: Trigger
metadata: {name: read-native-http}
spec: {source: {kind: http, method: POST, path: /api/native-query}, target: {procedure: read-native}}
`;
export function seed(pg:boolean):string {
 return cases.map(([id,payload,flag])=>`INSERT INTO wire_records(id,version,created_at,updated_at,payload,flag,quantity) VALUES('${id}',1,${pg?'now(),now()':'0,0'},${payload===undefined?'NULL':"'"+JSON.stringify(payload)+"'"},${flag===null?'NULL':pg?String(flag):Number(flag)},${id==='g'?'NULL':2});`).join('\n');
}
export async function verifyWire(fetch:(request:Request)=>Promise<Response|undefined>,bare:(id:string)=>Promise<any[]>,count:()=>number,sqlite:boolean,malformed=false):Promise<void> {
 const call=async(name:string,args:unknown)=>{
  const response=(await fetch(new Request('https://app.test/mcp',{method:'POST',headers:{'content-type':'application/json',accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}})})))!;
  const body=await response.text();return {response,data:JSON.parse(body.startsWith('event:')?body.split('data: ')[1]!.split('\n')[0]!:body)};
 };
 for(const [id,payload,flag] of cases) {
  const native=(await bare(id))[0];const expectedPayload=payload??null;
  assert.deepEqual(native.dataAlias,sqlite&&payload!==undefined?JSON.stringify(payload):expectedPayload);
  assert.equal(native.enabledAlias,sqlite&&flag!==null?Number(flag):flag);
  const beforeRest=count(),rest=(await fetch(new Request('https://app.test/api/views/wire-records?id='+id)))!;
  assert.equal(count()-beforeRest,1);assert.equal(rest.status,200);const row=(await rest.json() as any).rows[0];
  assert.deepEqual(row.dataAlias,expectedPayload);assert.equal(row.enabledAlias,flag);assert.equal(row.computedJson,native.computedJson);assert.equal(row.quantityAlias,id==='g'?null:2);assert.equal(row.versionAlias,1);assert.equal(row.computedInteger,native.computedInteger);
  const beforeMcp=count(),mcp=await call('wire_records',{id});assert.equal(count()-beforeMcp,1);assert.equal(mcp.response.status,200);
  assert.deepEqual(mcp.data.result.structuredContent.rows[0],row);assert.deepEqual(JSON.parse(mcp.data.result.content[0].text).rows[0],row);
  assert.deepEqual(native.dataAlias,sqlite&&payload!==undefined?JSON.stringify(payload):expectedPayload);
 }
 for(const args of [{id:'a',limit:0},{}]) {
  const before=count(),rest=(await fetch(new Request('https://app.test/api/views/wire-records?'+new URLSearchParams(args as any))))!;assert.equal(rest.status,400);assert.equal(count(),before);
  const mcp=await call('wire_records',args);assert.equal(mcp.data.result.isError,true);assert.equal(count(),before);
 }
 const native=(await bare('a'))[0],expectedNative={results:[[{payload:native.dataAlias,flag:native.enabledAlias}]]};
 assert.deepEqual((await call('read_native',{id:'a',version:1})).data.result.structuredContent,expectedNative);
 const http=(await fetch(new Request('https://app.test/api/native-query',{method:'POST',headers:{'content-type':'application/json'},body:'{"id":"a","version":2}'})))!;assert.deepEqual(await http.json(),expectedNative);
 const expectedRef={flag:0,payload:'[1]'},before=count();
 assert.deepEqual((await call('echo_native',{})).data.result.structuredContent,expectedRef);
 assert.deepEqual(await (await fetch(new Request('https://app.test/api/native',{method:'POST',headers:{'content-type':'application/json'},body:'{}'})))!.json(),expectedRef);assert.equal(count(),before);
 if(malformed) {
  const native=(await bare('z'))[0];assert.equal(native.dataAlias,'private-invalid-json');
  const response=(await fetch(new Request('https://app.test/api/views/wire-records?id=z')))!;assert.equal(response.status,500);const body=await response.text();assert.match(body,/INTERNAL_ERROR/);assert.ok(!body.includes('private-invalid-json'));
  const mcp=await call('wire_records',{id:'z'});assert.equal(mcp.data.result.isError,true);assert.match(mcp.data.result.content[0].text,/INTERNAL_ERROR/);assert.ok(!mcp.data.result.content[0].text.includes('private-invalid-json'));
 }
}
