import { test } from "bun:test";
import { Database } from "bun:sqlite";
import { SQL } from "bun";
import { d1Adapter, bunSqlAdapter } from "../src/auth/adapter.js";
import { d1Shim } from "./apps/d1-shim.js";
import { verifyOAuthResources } from "./auth-resource-scenarios.js";

test("generated OAuth resources: seeded, missing, no boot SQL, renamed models/fields on SQLite/D1 shim", async () => {
  const db = new Database(":memory:"), statements: string[] = [], native = d1Shim(db);
  db.exec("PRAGMA foreign_keys=ON");
  try { await verifyOAuthResources(d1Adapter({ prepare: text => { statements.push(text); return native.prepare(text); } }), "sqlite", async (text, values = []) => db.query(text).all(...values as never[]) as Record<string, unknown>[], statements); }
  finally { db.close(); }
});
const url = process.env.MANTLE_NEXT_BUN_PG_URL;
(url ? test : test.skip)("generated OAuth resources on PostgreSQL", async () => {
  const schema = `resources_${crypto.randomUUID().replaceAll("-", "")}`, admin = new SQL(url!), statements: string[] = [];
  await admin.unsafe(`CREATE SCHEMA "${schema}"`);
  const sql = new SQL(url!, { connection: { search_path: schema }, max: 1 });
  try { await verifyOAuthResources(bunSqlAdapter({ unsafe: (text: string, values: unknown[]) => { statements.push(text); return sql.unsafe(text, values); }, begin: sql.begin.bind(sql) } as never), "postgres", async (text, values = []) => [...await sql.unsafe(text, values)], statements); }
  finally { await sql.close(); await admin.unsafe(`DROP SCHEMA "${schema}" CASCADE`); await admin.close(); }
}, 30000);
