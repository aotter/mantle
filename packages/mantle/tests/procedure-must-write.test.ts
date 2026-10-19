import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { SQL } from "bun";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { userCaller } from "../src/kernel/user-caller.js";
import { generateFromSources } from "../src/infrastructure/generate.js";
import { generateOrThrow, writeGenerated } from "./apps/link.js";
await mkdir(resolve(import.meta.dir, "apps/.generated"), { recursive: true });

// #1775 (ADR-0034 decision 4): `handler.mustWrite` makes a set-op write fail with CONFLICT kind "row" when it writes no row.
const m = (kind: string, name: string, spec: object) => JSON.stringify({ apiVersion: "cms.mantle.aotter.net/v2", kind, metadata: { name }, spec });
const input = { type: "object", additionalProperties: false, properties: { client: { type: "string" }, name: { type: "string" } } };
const proc = (name: string, sql: string, mustWrite?: unknown) => m("Procedure", name, { title: name, input, output: { type: "object" }, handler: { sql, ...(mustWrite === undefined ? {} : { mustWrite }) } });
const schemas = [
  m("Schema", "clients", { title: "Clients", lifecycle: "operational", schema: { type: "object", required: ["name"], properties: { name: { type: "string" } } } }),
  m("Schema", "contacts", { title: "Contacts", lifecycle: "operational", schema: { type: "object", required: ["name"], properties: { name: { type: "string" }, client_id: { type: "string", "x-mantle-ref": "clients" } } } }),
  m("Schema", "audit", { title: "Audit", lifecycle: "operational", schema: { type: "object", required: ["note"], properties: { note: { type: "string" } } } }),
];
const create = "INSERT INTO contacts (name, client_id) SELECT input.name, input.client WHERE EXISTS (SELECT 1 FROM clients WHERE id = input.client) RETURNING id";
const text = [
  ...schemas,
  proc("add_contact", create, [1]),
  proc("add_contact_or_nothing", create),
  proc("add_logged", `INSERT INTO audit (note) VALUES (input.name); ${create}`, [2]),
  proc("rename_all", "UPDATE contacts SET name = input.name WHERE client_id = input.client", [1]),
].join("\n---\n");
const code = (run: () => Promise<unknown>) => run().then(() => "ok", (e: { code?: string; fields?: { kind?: string } }) => e.code ? `${e.code}${e.fields?.kind ? `:${e.fields.kind}` : ""}` : String(e));
const diagnostics = async (...docs: string[]) => {
  const result = await generateFromSources({ target: "bun-sqlite", sources: { sources: [{ sourceId: "must-write.yaml", text: [...schemas, ...docs].join("\n---\n") }] } });
  return result.ok ? [] : result.diagnostics.map(d => `${d.code} ${d.path}: ${d.message}`);
};

test("mustWrite: generation marks the named set op and refuses what it cannot apply to", async () => {
  for (const target of ["bun-sqlite", "bun-postgres", "cloudflare-d1"] as const) {
    const generated = (await generateOrThrow(target, [{ sourceId: "must-write.yaml", text }]))["generated.ts"]!;
    expect(generated.match(/row: "some"/g)?.length).toBe(3);       // add_contact, add_logged's second statement and rename_all, in both modes when they print alike
    expect(generated).toContain(", row: true }, { sql:");           // add_logged's INSERT … VALUES stays an exact row op
  }
  expect(await diagnostics(proc("p", create, [2]))).toEqual([expect.stringContaining("SQL_SHAPE must-write.yaml#/3/spec/handler/mustWrite/0: Procedure 'p' handler.mustWrite names statement 2, but the program has 1.")]);
  expect(await diagnostics(proc("p", "INSERT INTO audit (note) VALUES (input.name)", [1]))).toEqual([expect.stringContaining("names statement 1, a row op")]);
  expect(await diagnostics(proc("p", "UPDATE contacts SET name = input.name WHERE id = input.client", [1]))).toEqual([expect.stringContaining("which already must change exactly one row")]);
  for (const bad of [[], [0], [1, 1], [1.5], "1", true]) expect((await diagnostics(proc("p", create, bad))).join()).toContain("handler.mustWrite must be a non-empty list of distinct statement numbers, counting from 1");
  const ref = m("Procedure", "r", { title: "r", input, output: { type: "object" }, handler: { ref: "r", mustWrite: [1] } });
  expect((await diagnostics(ref)).join()).toContain("handler.mustWrite applies to a `sql` handler");
  expect(await diagnostics(proc("p", create, [1]))).toEqual([]);
});

for (const pg of [false, true]) (pg && !process.env.MANTLE_NEXT_BUN_PG_URL ? test.skip : test)(`mustWrite: no row written is CONFLICT kind row and rolls the program back (${pg ? "PostgreSQL" : "SQLite"})`, async () => {
  const files = await generateOrThrow(pg ? "bun-postgres" : "bun-sqlite", [{ sourceId: "must-write.yaml", text }]);
  const dir = await mkdtemp(resolve(import.meta.dir, "apps/.generated/must-write-")), namespace = "must_write_" + crypto.randomUUID().replaceAll("-", "");
  const db: any = pg ? new SQL(process.env.MANTLE_NEXT_BUN_PG_URL!, { max: 1 }) : new Database(":memory:");
  const rows = async (sql: string) => [...await (pg ? db.unsafe(sql) : Promise.resolve(db.query(sql).all()))];
  try {
    await writeGenerated(dir, files); const app = await import(resolve(dir, "generated.ts"));
    if (pg) { await db.unsafe(`CREATE SCHEMA ${namespace}`); await db.unsafe(`SET search_path TO ${namespace}`); await db.unsafe(files["schema.sql"]!); } else db.exec(files["schema.sql"]!);
    const caller = userCaller({ id: "a" }, {});
    const client = await app.store(db, caller).collection("clients").insert({ name: "acme" });
    const count = async (table: string) => Number((await rows(`SELECT count(*) AS n FROM ${table}`))[0]!.n);

    // the parent is missing: nothing is written, and the call is CONFLICT kind "row" instead of an empty success
    expect(await code(() => app.procedures.add_contact(db, caller, { client: "missing", name: "ghost" }))).toBe("CONFLICT:row");
    expect(await count("contacts")).toBe(0);
    // the same statement without mustWrite: writing no row is a valid, empty result
    expect(await app.procedures.add_contact_or_nothing(db, caller, { client: "missing", name: "ghost" })).toEqual({ results: [[]] });
    // the parent exists: one row
    const created = await app.procedures.add_contact(db, caller, { client: client.id, name: "ann" });
    expect(created.results[0]).toHaveLength(1);
    expect(await rows(`SELECT name, client_id FROM contacts WHERE id = '${created.results[0][0].id}'`)).toEqual([{ name: "ann", client_id: client.id }]);

    // several statements: the checked one writes no row, so the audit row written before it rolls back too
    expect(await code(() => app.procedures.add_logged(db, caller, { client: "missing", name: "logged" }))).toBe("CONFLICT:row");
    expect([await count("audit"), await count("contacts")]).toEqual([0, 1]);
    expect(await code(() => app.procedures.add_logged(db, caller, { client: client.id, name: "logged" }))).toBe("ok");
    expect([await count("audit"), await count("contacts")]).toEqual([1, 2]);

    // at least one row, not exactly one: a set UPDATE over two rows passes, over none is CONFLICT
    expect(await code(() => app.procedures.rename_all(db, caller, { client: client.id, name: "same" }))).toBe("ok");
    expect(await rows("SELECT name FROM contacts ORDER BY name")).toEqual([{ name: "same" }, { name: "same" }]);
    expect(await code(() => app.procedures.rename_all(db, caller, { client: "missing", name: "none" }))).toBe("CONFLICT:row");
  } finally { if (pg) { await db.unsafe(`DROP SCHEMA IF EXISTS ${namespace} CASCADE`); await db.close(); } else db.close(); await rm(dir, { recursive: true, force: true }); }
});
