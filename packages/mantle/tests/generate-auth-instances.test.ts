import { test, expect } from "bun:test";
import { admin } from "better-auth/plugins";
import { generateFromSources } from "../src/infrastructure/generateAuth.js";
import { oauthGrantRevocation } from "../src/auth/oauth.js";
const sources = { sources: [{ sourceId: "notes.json", text: JSON.stringify({ apiVersion: "cms.mantle.aotter.net/v2", kind: "Schema", metadata: { name: "notes" }, spec: { title: "Notes", lifecycle: "operational", schema: { type: "object", required: ["label"], properties: { label: { type: "string" } } } } }) }] };
const tables = (prefix: string) => ({ user: { modelName: `${prefix}_user` }, session: { modelName: `${prefix}_session` }, account: { modelName: `${prefix}_account` }, verification: { modelName: `${prefix}_verification` } });
const sql = (files: Readonly<Record<string, string>>) => Object.entries(files).filter(([name]) => name.endsWith(".sql")).map(([, text]) => text).join("\n");

test("every --auth instance gets its tables; a table two instances define differently is refused", async () => {
  const both = await generateFromSources({ target: "bun-postgres", sources, auth: [{ ...tables("staff"), plugins: [admin()] }, tables("customer")] });
  if (!both.ok) throw Error(JSON.stringify(both.diagnostics));
  for (const table of ["staff_user", "staff_session", "customer_user", "customer_session"]) expect(sql(both.files)).toContain(`CREATE TABLE IF NOT EXISTS "${table}"`);
  const same = await generateFromSources({ target: "bun-postgres", sources, auth: [{}, {}] });
  expect(same.ok).toBe(true);
  await expect(generateFromSources({ target: "bun-postgres", sources, auth: [{ plugins: [admin()] }, {}] })).rejects.toThrow('table "user" differently');
});

test("an OAuth provider without oauthGrantRevocation() is refused at generate", async () => {
  const provider = { id: "oauth-provider" } as never, revocation = oauthGrantRevocation() as never;
  await expect(generateFromSources({ target: "bun-sqlite", sources, auth: { plugins: [provider] } })).rejects.toThrow("without oauthGrantRevocation()");
  expect((await generateFromSources({ target: "bun-sqlite", sources, auth: { plugins: [revocation, provider] } })).ok).toBe(true);
});
