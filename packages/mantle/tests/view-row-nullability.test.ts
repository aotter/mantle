import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { generateFromSources } from "../src/infrastructure/generateAuth.js";
import { generateOrThrow, writeGenerated } from "./apps/link.js";
import { sdkFixtureCaller } from "./apps/fixtures.js";

const text = `apiVersion: cms.mantle.aotter.net/v2
kind: Schema
metadata: {name: carts}
spec:
  title: Carts
  lifecycle: operational
  schema:
    type: object
    required: [name, total]
    properties:
      name: {type: string}
      note: {type: string}
      total: {type: integer, readOnly: true, default: 0}
      hits: {type: integer, readOnly: true, default: 0}
---
apiVersion: cms.mantle.aotter.net/v2
kind: Schema
metadata: {name: lines}
spec:
  title: Lines
  lifecycle: operational
  schema:
    type: object
    required: [cartId, sku]
    properties: {cartId: {type: string, x-mantle-ref: carts}, sku: {type: string}}
---
apiVersion: cms.mantle.aotter.net/v2
kind: Schema
metadata: {name: posts}
spec:
  title: Posts
  lifecycle: publishing
  schema:
    type: object
    required: [title]
    properties: {title: {type: string}}
`;
const view = (name: string, sql: string) => `---
apiVersion: cms.mantle.aotter.net/v2
kind: View
metadata: {name: ${name}}
spec:
  surface: internal
  sql: ${sql}
`;
const views = [
  view(
    "direct",
    "SELECT c.id, c.name, c.note, c.total, c.hits, c.version, c.created_at, c.author_id FROM carts c ORDER BY c.id",
  ),
  view("joined", "SELECT c.id, c.name, l.sku AS inner_sku FROM carts c JOIN lines l ON l.cartId = c.id ORDER BY c.id"),
  view(
    "outer",
    "SELECT c.name, l.id AS line_id, l.sku FROM carts c LEFT JOIN lines l ON l.cartId = c.id ORDER BY c.id",
  ),
  view("grouped", "SELECT c.name, count(*) AS n, sum(c.total) AS spent FROM carts c GROUP BY c.name"),
  view("lone", "SELECT max(c.note) AS top, c.name FROM carts c"),
  view("nested", "SELECT s.name, s.label FROM (SELECT c.name, lower(c.name) AS label FROM carts c) s"),
  view("shared", "WITH s AS (SELECT c.name FROM carts c) SELECT s.name FROM s"),
  view("drafts", "SELECT p.id, p.title, p.status FROM posts p ORDER BY p.id"),
].join("");

const rowOf = (code: string, index: number) =>
  code.match(new RegExp(`export type View${index}Row = \\{ ([^\\n]*) \\};`))?.[1];

test("View rows keep a table column's NOT NULL; outer joins, aggregates, expressions and CTEs stay nullable", async () => {
  for (const [target, int, bigint] of [
    ["bun-sqlite", "number", "number"],
    ["bun-postgres", "number | string | bigint", "number | string | bigint"],
  ] as const) {
    const files = await generateOrThrow(target, [{ sourceId: "carts.yaml", text: text + views }]);
    const code = files["generated.ts"]!;
    // Views are numbered in name order: direct, drafts, grouped, joined, lone, nested, outer, shared
    expect(rowOf(code, 0)).toBe(
      `readonly "id": string; readonly "name": string; readonly "note": string | null; readonly "total": ${int}; readonly "hits": ${int} | null; readonly "version": ${bigint}; readonly "created_at": string; readonly "author_id": string | null;`,
    );
    expect(rowOf(code, 1)).toBe(`readonly "id": string; readonly "title": string | null; readonly "status": string;`);
    expect(rowOf(code, 2)).toBe(`readonly "name": string; readonly "n": unknown; readonly "spent": ${int} | null;`);
    expect(rowOf(code, 3)).toBe(`readonly "id": string; readonly "name": string; readonly "inner_sku": string;`);
    // SQLite returns one row over no rows: the bare column beside the aggregate is then NULL
    expect(rowOf(code, 4)).toBe(`readonly "top": string | null; readonly "name": string | null;`);
    expect(rowOf(code, 5)).toBe(`readonly "name": string; readonly "label": unknown;`);
    expect(rowOf(code, 6)).toBe(
      `readonly "name": string; readonly "line_id": string | null; readonly "sku": string | null;`,
    );
    expect(rowOf(code, 7)).toBe(`readonly "name": string | null;`);
    // the wire row narrows the same way
    expect(code).toMatch(
      /export type View0WireRow = \{ readonly "id": View0Row\["id"\]; readonly "name": string; readonly "note": string \| null; readonly "total": number \| string; readonly "hits": number \| string \| null;/,
    );
    // required + default is the NOT NULL server-maintained field; default alone stays nullable in DDL and in the Store
    expect(files["schema.sql"]).toMatch(/"?total"? (INTEGER|int8) NOT NULL/);
    expect(files["schema.sql"]).not.toMatch(/"?hits"? (INTEGER|int8) NOT NULL/);
    expect(code).toMatch(
      new RegExp(
        `carts: \\{ row: \\{[^}]* total: ${int.replace(/\|/g, "\\|")}; hits: ${int.replace(/\|/g, "\\|")} \\| null;`,
      ),
    );
  }
});

test("a readOnly field that is also required: Admin create fills its default, the Store must name it, and the DDL refuses NULL", async () => {
  const source = `apiVersion: cms.mantle.aotter.net/v2
kind: Schema
metadata: {name: carts}
spec:
  title: Carts
  lifecycle: operational
  schema:
    type: object
    required: [name, total]
    properties: {name: {type: string}, total: {type: integer, readOnly: true, default: 0}}
`;
  const generated = await generateFromSources({
    target: "bun-sqlite",
    admin: true,
    sources: { sources: [{ sourceId: "carts.yaml", text: source }] },
  });
  if (!generated.ok) throw Error(JSON.stringify(generated.diagnostics));
  const dir = await mkdtemp(join(import.meta.dir, "apps/.readonly-default-")),
    db = new Database(":memory:");
  try {
    // generated code links to the sources, and the Admin helper to Admin's own source
    const native = await readFile(resolve(import.meta.dir, "../../mantle-admin/src/server/native.ts"), "utf8");
    const files = Object.fromEntries(
      Object.entries(generated.files).map(([name, text]) => [
        name,
        text.replaceAll(
          '"@aotter/mantle-admin/server/native"',
          `"./${name.startsWith("admin/") ? "../" : ""}native-admin.js"`,
        ),
      ]),
    );
    await writeGenerated(dir, { ...files, "native-admin.ts": native }, false);
    db.exec(generated.files["schema.sql"]!);
    const { adminBindings } = await import(join(dir, "admin-bindings.ts")),
      { nativeEntryProcedure } = await import(join(dir, "native-admin.ts"));
    const bindings = adminBindings(),
      carts = bindings.schemas[0];
    const admin = sdkFixtureCaller({
      kind: "user",
      subject: "a",
      role: "admin",
      admin: true,
      scopes: [],
      credential: "session",
      credentialId: null,
      clientId: null,
    });
    // Admin's POST /entries: defaults under the client's data, the full validator, then the readOnly field pinned to its default
    const create = (data: Record<string, unknown>) =>
      nativeEntryProcedure(
        carts.binding,
        bindings.adapter,
        db,
        admin,
        "create",
        carts.values(carts.validate({ ...carts.defaults, ...data }, true)),
      );
    expect(Number((await create({ name: "omitted" })).total)).toBe(0);
    expect(Number((await create({ name: "forged", total: 99 })).total)).toBe(0);
    const app = await import(join(dir, "generated.ts")),
      store = app.store(db, { kind: "system", reason: "test" }).collection("carts");
    expect(Number((await store.insert({ name: "server", total: 0 })).total)).toBe(0);
    // the Store applies no JSON Schema default: server code names the field (its insert type requires it), and NOT NULL refuses the omission
    await expect((async () => await store.insert({ name: "no total" }))()).rejects.toThrow(/NOT NULL/);
    expect(() =>
      db.exec("INSERT INTO carts (id, version, created_at, updated_at, name) VALUES ('raw', 1, 0, 0, 'raw')"),
    ).toThrow(/NOT NULL/);
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

// #2091: text composed in SQL from text columns and string literals is text; anything else stays unknown
const composed = [
  view(
    "composed",
    "SELECT c.name || c.note AS joined, c.name || E'\\n\\n' || c.name AS doubled, c.name || ' x' AS tagged, coalesce(c.note, c.name) AS either, coalesce(c.note, '') AS filled, coalesce(c.note, c.note) AS maybe, c.id || '/' || c.name AS path FROM carts c ORDER BY c.id",
  ),
  view(
    "unknowns",
    "SELECT c.total || c.name AS mixed, c.created_at || c.name AS stamped, coalesce(c.total, c.hits) AS ints, coalesce(c.note, NULL) AS nul, coalesce(c.note, c.total) AS diverse, CAST(c.name AS text) AS cast_name, lower(c.name) || c.name AS lowered FROM carts c ORDER BY c.id",
  ),
  view(
    "joined-text",
    "SELECT c.name || l.sku AS outer_text, coalesce(l.sku, c.name) AS outer_filled FROM carts c LEFT JOIN lines l ON l.cartId = c.id ORDER BY c.id",
  ),
  view("nested-text", "SELECT s.label FROM (SELECT c.name || '!' AS label FROM carts c) s"),
  view("lone-text", "SELECT count(*) AS n, c.name || '' AS label FROM carts c"),
].join("");

test("a View output composed from text with || or COALESCE is text on every target; mixed or unknown operands stay unknown", async () => {
  for (const target of ["bun-sqlite", "cloudflare-d1", "bun-postgres", "cloudflare-postgres"] as const) {
    const code = (await generateOrThrow(target, [{ sourceId: "carts.yaml", text: text + composed }]))["generated.ts"]!;
    // Views are numbered in name order: composed, joined-text, lone-text, nested-text, unknowns
    expect(rowOf(code, 0)).toBe(
      `readonly "joined": string | null; readonly "doubled": string; readonly "tagged": string; readonly "either": string; readonly "filled": string; readonly "maybe": string | null; readonly "path": string;`,
    );
    expect(rowOf(code, 1)).toBe(`readonly "outer_text": string | null; readonly "outer_filled": string;`);
    // without GROUP BY, an aggregate makes one row over no rows, and a column beside it is then NULL
    expect(rowOf(code, 2)).toBe(`readonly "n": unknown; readonly "label": string | null;`);
    expect(rowOf(code, 3)).toBe(`readonly "label": string;`);
    expect(rowOf(code, 4)).toBe(
      `readonly "mixed": unknown; readonly "stamped": unknown; readonly "ints": unknown; readonly "nul": unknown; readonly "diverse": unknown; readonly "cast_name": unknown; readonly "lowered": unknown;`,
    );
    // a computed output's wire row is its native row: no transport conversion is added
    expect(code).toMatch(/export type View0WireRow = \{ readonly "joined": View0Row\["joined"\];/);
  }
});
