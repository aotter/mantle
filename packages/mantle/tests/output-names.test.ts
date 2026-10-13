import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateOrThrow, writeGenerated } from "./apps/link.js";

const text = `apiVersion: cms.mantle.aotter.net/v2
kind: Schema
metadata: {name: requests}
spec:
  title: Requests
  lifecycle: operational
  schema:
    type: object
    properties: {reqStatus: {type: string}}
---
apiVersion: cms.mantle.aotter.net/v2
kind: View
metadata: {name: requests}
spec:
  surface: internal
  sql: SELECT r.id, r.reqStatus, r.reqStatus AS "reqStatusCopy", r.reqStatus AS explicitName FROM requests r ORDER BY r.id
---
apiVersion: cms.mantle.aotter.net/v2
kind: Procedure
metadata: {name: save}
spec:
  input: {type: object, properties: {state: {type: string}}}
  output: {type: object}
  handler:
    sql: INSERT INTO requests(reqStatus) VALUES (input.state) RETURNING id, reqStatus, reqStatus AS "reqStatusCopy", reqStatus AS explicitName
`;
test("direct View and RETURNING columns retain SQL names on both dialects; aliases keep SQL names", async () => {
  for (const target of ["bun-sqlite", "bun-postgres"] as const) {
    const files = await generateOrThrow(target,[{sourceId:"names.yaml",text}]);
    expect(files["generated.ts"]).toContain('readonly "reqstatus": string | null');
    expect(files["generated.ts"]).toContain('readonly "reqStatusCopy": string | null');
    expect(files["generated.ts"]).toContain('readonly "explicitname": string | null');
    if (target !== "bun-sqlite") continue;
    const dir = await mkdtemp(join(tmpdir(),"mantle-names-")), db = new Database(":memory:");
    try {
      await writeGenerated(dir,files); db.exec(files["schema.sql"]!);
      const {default:save} = await import(join(dir,"procedures/save.ts"));
      const {default:view} = await import(join(dir,"views/requests.ts"));
      const output = await save(db,{kind:"system"},{state:"submitted"});
      expect(output.results[0][0]).toMatchObject({reqstatus:"submitted",reqStatusCopy:"submitted",explicitname:"submitted"});
      expect(await view(db,{kind:"anonymous"},{})).toEqual(output.results[0]);
    } finally {db.close();await rm(dir,{recursive:true,force:true});}
  }
});

test("generation warns about case-folded direct outputs, but accepts aliases and lower-case names", async () => {
  const {generateFromSources} = await import("../src/infrastructure/generate.js");
  for (const target of ["bun-sqlite", "bun-postgres"] as const) {
    const result = await generateFromSources({target,sources:{sources:[{sourceId:"names.yaml",text}]}});
    expect(result.ok).toBe(true);
    if (!result.ok) throw Error(JSON.stringify(result.diagnostics));
    expect(result.warnings).toEqual([
      `View 'requests' field 'reqStatus' outputs storage name 'reqstatus'; use r.reqStatus AS "reqStatus" to preserve the declared name.`,
      `Procedure 'save' field 'reqStatus' outputs storage name 'reqstatus'; use reqStatus AS "reqStatus" to preserve the declared name.`,
    ]);
    for (const clean of [text.replace('r.reqStatus,', 'r.reqStatus AS "reqStatus",').replace('id, reqStatus,','id, reqStatus AS "reqStatus",'), text.replaceAll('reqStatus','reqstatus')]) {
      const result = await generateFromSources({target,sources:{sources:[{sourceId:"names.yaml",text:clean}]}});
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.warnings).toEqual([]);
    }
  }
});
