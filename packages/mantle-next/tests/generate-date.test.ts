import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { writeFile, unlink } from "node:fs/promises";
import { generateFromSources } from "../src/infrastructure/generate.js";

const source = `apiVersion: cms.mantle.aotter.net/v2
kind: View
metadata: {name: utc-day}
spec:
  surface: public
  sql: |
    SELECT date_trunc('day', CAST('2026-10-11T12:34:56.123456Z' AS timestamptz)) AS day
`;

test("canonical UTC DDL supplies timezone offsets used by generated date SQL", async () => {
  const generated = await generateFromSources({checked:true,target:"bun-sqlite",sources:{sources:[{sourceId:"utc.yaml",text:source}]}});
  if (!generated.ok) throw Error(JSON.stringify(generated.diagnostics));
  expect(generated.files["schema.sql"]).toContain("CREATE TABLE IF NOT EXISTS _mantle_tz");
  expect(generated.files["schema.sql"]).toContain("(-9007199254740991, 0)");
  expect(generated.files["checked.ts"]).toContain("_mantle_tz");
  const file = new URL(`.date-${crypto.randomUUID()}.ts`, import.meta.url);
  await writeFile(file, generated.files["checked.ts"]!);
  const db = new Database(":memory:");
  try {
    db.exec(generated.files["schema.sql"]!);
    const app = await import(file.href);
    const rows = await app.views["utc-day"](db,{kind:"anonymous"},{});
    expect(rows).toEqual([{day:Date.parse("2026-10-11T00:00:00Z")*1000}]);
  } finally { db.close(); await unlink(file); }
});
