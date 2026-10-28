import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { admin as createAdmin } from "../../src/server/index.js";
import { entries } from "../../src/server/entries.js";
import { generateAdmin, writeAdminFixture } from "./generated-fixture.js";
import { sdkFixtureCaller } from "../../../mantle/tests/apps/fixtures.js";

test("PostgreSQL serialization/deadlock refusals stay CONFLICT through generated Store, REST, MCP and Admin", async () => {
  const source = await readFile(join(import.meta.dir, "../../../mantle/tests/apps/postgres-conflicts.yaml"), "utf8");
  const caller = sdkFixtureCaller({kind:"user",subject:"editor",role:"admin",admin:true,scopes:["mcp"],credential:"oauth",credentialId:null,clientId:null});
  for (const target of ["bun-postgres", "cloudflare-postgres"] as const) {
    const files = await generateAdmin(target, source);
    const dir = await mkdtemp(join(import.meta.dir, "../../../mantle/tests/apps/.pg-conflict-"));
    try {
      await writeAdminFixture(dir, files);
      const generated = await import(join(dir, "generated.ts"));
      const {rest} = await import(join(dir, "rest.ts")), {mcp} = await import(join(dir, "mcp.ts"));
      const {adminBindings} = await import(join(dir, "admin-bindings.ts")), bindings = adminBindings();
      for (const state of ["40001", "40P01"]) {
        const cause = Object.assign(new Error("private-SQLSTATE-" + state), target === "bun-postgres"
          ? {errno:state,code:"ERR_POSTGRES_SERVER_ERROR",severity:"ERROR"} : {code:state,severity:"ERROR"});
        let attempts = 0;
        const db = { unsafe: async () => { throw Error("Expected transaction"); }, begin: async (_options: string, fn: (tx: unknown) => Promise<unknown>) => {
          attempts++;
          return fn({unsafe:async () => { throw cause; }});
        } };
        const store = generated.store(db, caller), notes = store.collection("notes");
        await expect(store.batch([notes.insert({title:"one"}),notes.insert({title:"two"})])).rejects.toMatchObject({code:"CONFLICT",fields:{kind:"serialization"},cause});
        const options = {db:()=>db,caller:()=>caller};
        const input = {id:"note",title:"changed",version:1};
        const request = (path: string, body: unknown) => new Request("https://app.test"+path, {method:"POST",headers:{origin:"https://app.test","content-type":"application/json",accept:"application/json, text/event-stream"},body:JSON.stringify(body)});
        const response = await rest(options)(request("/api/change", input), {});
        expect(response.status).toBe(409);
        const body = await response.json();
        expect(body).toMatchObject({error:{code:"CONFLICT",kind:"serialization"}});
        const adminCaller = sdkFixtureCaller({...caller,credential:"session",credentialId:null});
        const admin = createAdmin(bindings.metadata,bindings.views,bindings.operations,{...options,caller:()=>adminCaller,routes:entries(bindings.schemas,bindings.adapter)});
        const adminResponse = await admin(request("/admin/api/operations/change", input), {});
        expect(adminResponse!.status).toBe(409);
        const adminBody = await adminResponse!.json();
        expect(adminBody).toMatchObject({error:{code:"CONFLICT",kind:"serialization"}});
        const mcpResponse = await mcp({...options,allowedOrigins:["https://app.test"]})(request("/mcp/admin",{jsonrpc:"2.0",id:1,method:"tools/call",params:{name:"change",arguments:input}}),{});
        const text = await mcpResponse.text();
        const data = JSON.parse(text.startsWith("event:") ? text.split("data: ")[1]!.split("\n")[0]! : text);
        expect(data).toMatchObject({result:{isError:true}});
        const mcpBody = JSON.parse(data.result.content[0].text);
        expect(mcpBody.diagnostics[0]).toMatchObject({code:"CONFLICT",kind:"serialization"});
        expect(JSON.stringify([body,adminBody,mcpBody])).not.toContain("private-SQLSTATE");
        expect(attempts).toBe(4); // exactly one attempt on each surface; no automatic retry
      }
    } finally { await rm(dir,{recursive:true,force:true}); }
  }
},30000);
