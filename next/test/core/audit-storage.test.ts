import { afterEach, describe, expect, it } from "vitest";
import { LocalD1 } from "../../src/cloudflare/testing/d1.js";
import { compilePlan, compileSql, DiagnosticError } from "../../src/spec/index.js";
import { convergeStorage, type StorageSchema } from "../../src/core/sql/storage.js";
import { decodeDate, encodeDate, encodeTimestamptz } from "../../src/core/sql/codec.js";
import { print } from "../../src/core/sql/print.js";
import { transitions } from "../../src/core/sql/tz.js";
import { createMantleRuntime, type Caller } from "../../src/core/index.js";
import { sqliteStorage } from "../../src/core/sql/adapter.js";

const open: LocalD1[] = [];
const db = async () => { const d = await LocalD1.create(); open.push(d); return d; };
afterEach(async () => { await Promise.all(open.splice(0).map((d) => d.dispose())); });
const run = (d: LocalD1, plan: Record<string, StorageSchema>, fingerprint: string) => convergeStorage(d, plan, { fingerprint });
const tables = async (d: LocalD1) => (await d.all("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name")).map((r) => String(r.name));

describe("storage convergence (Opus audit)", () => {
  it("one R*Tree per geo field, so near() on the second field reads its own tree", async () => {
    const d = await db();
    await run(d, { two: { fields: { a: "geo", b: "geo" } } }, "f1");
    await d.exec("INSERT INTO two (id, created_at, b_lat, b_lng) VALUES ('r', 0, 25, 121)");
    expect(await d.all("SELECT count(*) AS c FROM _mantle_geo_two_b")).toEqual([{ c: 1 }]);
    expect(await d.all("SELECT count(*) AS c FROM _mantle_geo_two_a")).toEqual([{ c: 0 }]);
    // reordering the fields changes no tree
    await run(d, { two: { fields: { b: "geo", a: "geo" } } }, "f2");
    expect(await d.all("SELECT count(*) AS c FROM _mantle_geo_two_b")).toEqual([{ c: 1 }]);
  });

  it("a Schema named like another's FTS5 or R*Tree shadow table does not stop boot", async () => {
    const d = await db();
    const plan = { x: { fields: { t: "text" }, search: ["t"] }, x_data: { fields: {} }, p: { fields: { loc: "geo" } }, p_node: { fields: {} } };
    await run(d, plan, "f1");
    await expect(run(d, plan, "f2")).resolves.toMatchObject({ blocked: [] });
  });

  it("blocks a _rid that is not the rowid alias, a column UNIQUE nobody declared, and a partial declared index", async () => {
    const d = await db();
    await d.exec("CREATE TABLE _mantle_schema_tables (name TEXT PRIMARY KEY) STRICT");
    await d.exec("CREATE TABLE items (_rid INTEGER, id TEXT NOT NULL UNIQUE, version INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL DEFAULT 0, author_id TEXT, name TEXT UNIQUE) STRICT", "INSERT INTO _mantle_schema_tables VALUES ('items')");
    const r = await run(d, { items: { fields: { name: "text" } } }, "f1");
    const text = r.blocked.map((b) => b.message).join("\n");
    expect(text).toMatch(/_rid is not the table's INTEGER PRIMARY KEY/);
    expect(text).toMatch(/UNIQUE constraint on name/);
    const e = await db();
    await run(e, { u: { fields: { name: "text" }, unique: [["name"]] } }, "f1");
    await e.exec("DROP INDEX _mantle_uq_u_0", "CREATE UNIQUE INDEX _mantle_uq_u_0 ON u (name) WHERE name <> 'dup'");
    expect((await run(e, { u: { fields: { name: "text" }, unique: [["name"]] } }, "f2")).blocked.map((b) => b.message).join()).toMatch(/other columns, uniqueness or a WHERE/);
  });

  it("two boots adding the same Schema both succeed", async () => {
    const d = await db();
    await run(d, { a: { fields: {} } }, "f1");
    const plan = { a: { fields: {} }, b: { fields: { n: "integer" } } };
    const both = await Promise.allSettled([run(d, plan, "f2"), run(d, plan, "f2")]);
    expect(both.map((x) => x.status)).toEqual(["fulfilled", "fulfilled"]);
    expect(await tables(d)).toContain("b");
  });
});

describe("codec and time (Opus audit)", () => {
  it("dates before year 100 keep their year, a day that does not exist is refused, and timestamps stay whole and in range", () => {
    expect(decodeDate(encodeDate("0050-06-15"))).toBe("0050-06-15");
    expect(() => encodeTimestamptz("2026-02-30T00:00:00Z")).toThrow(/not a date|not a valid/);
    for (const bad of [1.5, 2 ** 60, Number.NaN]) expect(() => encodeTimestamptz(bad)).toThrow(/microseconds/);
    expect(() => encodeTimestamptz("2285-06-05T23:47:34.740993Z")).toThrow(/not a valid timestamp/);
  });

  it("the time zone table covers 1900 to 2200, not 1970 to 2100", () => {
    const at = (zone: string, iso: string) => { const t = Date.parse(iso) * 1000; return transitions(zone).filter((r) => r.from_us <= t).at(-1)!.offset_us / 3_600_000_000; };
    expect([at("America/New_York", "1969-07-01T12:00:00Z"), at("America/New_York", "2101-07-01T12:00:00Z"), at("Asia/Taipei", "1960-06-01T00:00:00Z")]).toEqual([-4, -4, 9]);
  });
});

describe("the printer", () => {
  it("prints LIKE with only the parser's own like_escape as ESCAPE; any other function is an ordinary pattern", async () => {
    const ir = async (where: string) => { const r = await compileSql(`SELECT id FROM items WHERE ${where}`, { schemas: { items: { fields: { name: "text" } } }, inputs: { p: "text" }, kind: "view" }); if (!r.ok) throw new Error(r.diagnostic.message); return print(r.plan.stmts[0]!); };
    expect(await ir("name LIKE lower('APP%')")).toMatch(/LIKE lower\('APP%'\)/);
    expect(await ir("name LIKE replace(input.p, '*', '%')")).not.toMatch(/ESCAPE/);
    expect(await ir("name LIKE 'a!%' ESCAPE '!'")).toMatch(/ESCAPE '!'/);
  });
});

const MANIFEST = `apiVersion: cms.mantle.aotter.net/v2
kind: Schema
metadata: { name: my-items }
spec:
  title: Items
  lifecycle: operational
  checks: ["url LIKE 'https:%'"]
  schema: { type: object, properties: { url: { type: string } } }
`;
describe("errors stay Diagnostics (Opus audit)", () => {
  const user: Caller = { kind: "user", subject: "u", role: null, scopes: [], credential: "session", credentialId: null, clientId: null };
  it("a check with a colon, a Schema name that is not \\w, and a value that does not fit the column", async () => {
    const res = await compilePlan({ sources: [{ sourceId: "memory:a", text: MANIFEST }] });
    if (!res.ok) throw new Error(JSON.stringify(res.diagnostics));
    const d = await db();
    const rt = await createMantleRuntime({ plan: res.plan, handlers: {}, storage: sqliteStorage(d) });
    const err = async (p: Promise<unknown>) => (await p.then(() => undefined, (e) => e)) as DiagnosticError;
    const e1 = await err(rt.store.as(user).write([{ insert: "my-items", values: { url: "http://x" } }]));
    expect(e1.diagnostic).toMatchObject({ code: "INPUT_VALIDATION_FAILED", message: expect.stringMatching(/^CHECK my-items: url LIKE 'https:%'$/) });
    await rt.store.as(user).write([{ insert: "my-items", values: { url: "https://x" } }]);
  });
});
