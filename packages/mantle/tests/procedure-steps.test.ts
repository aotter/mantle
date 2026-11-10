import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { SQL } from "bun";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { userCaller } from "../src/kernel/user-caller.js";
import { generateFromSources } from "../src/infrastructure/generate.js";
import { generateOrThrow, writeGenerated } from "./apps/link.js";
import { verifyOnLocalD1 } from "./apps/local-d1.js";
import { verifyProcedureSteps } from "./procedure-steps-scenarios.js";
import { fixtureCaller } from "./apps/fixtures.js";
await mkdir(resolve(import.meta.dir, "apps/.generated"), { recursive: true });

// #1874 (ADR-0034 decision 4): a Procedure written as `handler.steps`, one statement each; a set-op step with
// `onNoRows: conflict` that writes no row fails with CONFLICT kind "row" and the whole program rolls back.
const m = (kind: string, name: string, spec: object) =>
  JSON.stringify({ apiVersion: "cms.mantle.aotter.net/v2", kind, metadata: { name }, spec });
const input = {
  type: "object",
  additionalProperties: false,
  properties: { client: { type: "string" }, name: { type: "string" } },
};
const proc = (name: string, handler: object) =>
  m("Procedure", name, { title: name, input, output: { type: "object" }, handler });
const schemas = [
  m("Schema", "clients", {
    title: "Clients",
    lifecycle: "operational",
    schema: { type: "object", required: ["name"], properties: { name: { type: "string" } } },
  }),
  m("Schema", "contacts", {
    title: "Contacts",
    lifecycle: "operational",
    schema: {
      type: "object",
      required: ["name"],
      properties: { name: { type: "string" }, client_id: { type: "string", "x-mantle-ref": "clients" } },
    },
  }),
  m("Schema", "audit", {
    title: "Audit",
    lifecycle: "operational",
    schema: { type: "object", required: ["note"], properties: { note: { type: "string" } } },
  }),
];
const create =
  "INSERT INTO contacts (name, client_id) SELECT input.name, input.client WHERE EXISTS (SELECT 1 FROM clients WHERE id = input.client) RETURNING id";
const log = "INSERT INTO audit (note) VALUES (input.name)";
const text = [
  ...schemas,
  proc("add_contact", { steps: [{ sql: create, onNoRows: "conflict" }] }),
  proc("add_contact_or_nothing", { sql: create }),
  proc("add_logged", { steps: [{ sql: `${log};` }, { sql: create, onNoRows: "conflict" }] }),
  proc("rename_all", {
    steps: [{ sql: "UPDATE contacts SET name = input.name WHERE client_id = input.client", onNoRows: "conflict" }],
  }),
  proc("add_named", {
    steps: [
      { name: "contact", sql: create, onNoRows: "conflict" },
      {
        name: "audit",
        sql: "INSERT INTO audit (note) SELECT input.name WHERE input.name <> 'blocked'",
        onNoRows: "conflict",
      },
    ],
  }),
  proc("rename_client", {
    steps: [{ name: "client", sql: "UPDATE clients SET name = input.name WHERE id = input.client" }],
  }),
].join("\n---\n");
const generate = (target: "bun-sqlite" | "bun-postgres" | "cloudflare-d1", ...docs: string[]) =>
  generateFromSources({
    target,
    sources: { sources: [{ sourceId: "steps.yaml", text: [...schemas, ...docs].join("\n---\n") }] },
  });
const diagnostics = async (...docs: string[]) => {
  const result = await generate("bun-sqlite", ...docs);
  return result.ok ? [] : result.diagnostics.map(d => `${d.code} ${d.path}: ${d.message}`);
};

test("steps: generation marks the set op that says onNoRows: conflict", async () => {
  for (const target of ["bun-sqlite", "bun-postgres", "cloudflare-d1"] as const) {
    const generated = (await generateOrThrow(target, [{ sourceId: "steps.yaml", text }]))["generated.ts"]!;
    expect(generated.match(/row: "some"/g)?.length).toBe(5); // add_contact, add_logged's second step, rename_all and add_named's two, in both modes when they print alike
    expect(generated).toContain(", row: true }, { sql:"); // add_logged's INSERT … VALUES stays an exact row op
  }
});

test("steps without onNoRows generate exactly what the same sql does", async () => {
  const update = "UPDATE contacts SET name = input.name WHERE client_id = input.client -- every contact of the client";
  for (const target of ["bun-sqlite", "bun-postgres", "cloudflare-d1"] as const) {
    const sql = await generate(target, proc("p", { sql: `${log};\n${update}\n;\n${create}` }));
    const steps = await generate(
      target,
      proc("p", { steps: [{ sql: log }, { sql: `${update}` }, { sql: `${create};\n` }] }),
    );
    if (!sql.ok || !steps.ok) throw Error(JSON.stringify([sql, steps]));
    // only the declaration as authored differs: Admin's developer console shows the steps, and the target hash covers them
    const declared = (files: Readonly<Record<string, string>>) =>
      Object.fromEntries(
        Object.entries(files).map(([file, code]) => [
          file,
          code
            .replace(/"procedure:p":\{"targetHash":"[0-9a-f]{64}"/, "")
            .replace(/^export const developerConsole = .*$/gm, ""),
        ]),
      );
    expect(Object.keys(steps.files)).toEqual(Object.keys(sql.files));
    expect(declared(steps.files)).toEqual(declared(sql.files));
    expect(Object.values(steps.files).join()).toContain(
      '"handler":{"steps":[{"sql":"INSERT INTO audit (note) VALUES (input.name)"},',
    );
  }
});

test("steps: generation refuses what it cannot apply", async () => {
  const one = (handler: object) => diagnostics(proc("p", handler));
  // shape: exactly one of sql, steps and ref; a non-empty list of { sql, onNoRows? }; onNoRows is only `conflict`
  expect(await one({ sql: create, steps: [{ sql: create }] })).toEqual([
    'INVALID_MANIFEST_ENVELOPE /spec/handler: [doc 3] Procedure.spec.handler must have exactly one key, `sql`, `steps` or `ref`; got ["sql","steps"]',
  ]);
  expect(await one({ ref: "p", steps: [{ sql: create }] })).toEqual([
    expect.stringContaining("must have exactly one key, `sql`, `steps` or `ref`"),
  ]);
  for (const steps of [[], "INSERT INTO audit (note) VALUES ('x')", {}])
    expect(await one({ steps })).toEqual([
      expect.stringMatching(
        /^INVALID_MANIFEST_ENVELOPE \/spec\/handler\/steps: \[doc 3\] Procedure\.spec\.handler\.steps must be a non-empty list of steps, each \{ sql, onNoRows\?, name\? \}/,
      ),
    ]);
  expect(await one({ steps: ["UPDATE contacts SET name = 'x'"] })).toEqual([
    expect.stringContaining(
      "INVALID_MANIFEST_ENVELOPE /spec/handler/steps/0: [doc 3] Procedure.spec.handler.steps[0] must be an object { sql, onNoRows?, name? }",
    ),
  ]);
  expect(await one({ steps: [{ sql: create }, { sql: "  " }] })).toEqual([
    expect.stringContaining(
      "INVALID_MANIFEST_ENVELOPE /spec/handler/steps/1/sql: [doc 3] Procedure.spec.handler.steps[1].sql is required (one statement)",
    ),
  ]);
  expect(await one({ steps: [{ sql: create, onNoRows: "conflict", expect: 1 }] })).toEqual([
    expect.stringContaining(
      "INVALID_MANIFEST_ENVELOPE /spec/handler/steps/0/expect: [doc 3] spec.handler.steps.0.expect is not supported",
    ),
  ]);
  // #1974: a step name is a short identifier, unique within the Procedure
  for (const name of ["", "1st", "-a", "a b", "a".repeat(65), 7])
    expect(await one({ steps: [{ sql: create, name }] })).toEqual([
      expect.stringContaining(
        `INVALID_MANIFEST_ENVELOPE /spec/handler/steps/0/name: [doc 3] Procedure.spec.handler.steps[0].name must be an identifier of at most 64 characters`,
      ),
    ]);
  expect(
    await one({
      steps: [
        { sql: log, name: "a" },
        { sql: create, name: "a" },
      ],
    }),
  ).toEqual([
    "INVALID_MANIFEST_ENVELOPE /spec/handler/steps/1/name: [doc 3] Procedure.spec.handler.steps[1].name 'a' names another step of this Procedure",
  ]);
  expect(
    await one({
      steps: [
        { sql: log, name: "audit_1" },
        { sql: create, name: "Contact-2" },
      ],
    }),
  ).toEqual([]);
  for (const onNoRows of ["CONFLICT", "ignore", true])
    expect(await one({ steps: [{ sql: create, onNoRows }] })).toEqual([
      expect.stringContaining(
        `INVALID_MANIFEST_ENVELOPE /spec/handler/steps/0/onNoRows: [doc 3] Procedure.spec.handler.steps[0].onNoRows must be \`conflict\`; got ${JSON.stringify(onNoRows)}`,
      ),
    ]);
  // the numbered form (#1775) never shipped in a stable release: refused with the rewrite
  for (const handler of [
    { sql: create, mustWrite: [1] },
    { ref: "p", mustWrite: [1] },
  ])
    expect(await one(handler)).toEqual([
      expect.stringContaining(
        'INVALID_MANIFEST_ENVELOPE /spec/handler/mustWrite: [doc 3] Procedure.spec.handler.mustWrite was replaced by handler.steps[].onNoRows: conflict (#1874). Write the program as steps, one statement each, and mark the set op that must write: handler: { steps: [{ sql: "INSERT INTO … SELECT … WHERE …", onNoRows: conflict }, { sql: "UPDATE …" }] }',
      ),
    ]);

  // one statement per step: several, or none, point at the step
  expect(await one({ steps: [{ sql: create }, { sql: `${log}; ${create}`, onNoRows: "conflict" }] })).toEqual([
    "SQL_SHAPE steps.yaml#/3/spec/handler/steps/1/sql: Procedure 'p' handler.steps[1] must be exactly one statement; it has 2. Write each statement as its own step",
  ]);
  expect(await one({ steps: [{ sql: "-- nothing yet" }] })).toEqual([
    "SQL_SHAPE steps.yaml#/3/spec/handler/steps/0/sql: Procedure 'p' handler.steps[0] must be exactly one statement; it has none. Write each statement as its own step",
  ]);
  // a refusal inside a step points at that step, with the line counted from the step's own first line
  expect(
    await one({ steps: [{ sql: log }, { sql: "UPDATE contacts\n  SET name = input.name WHERE client_id = (" }] }),
  ).toEqual([expect.stringMatching(/^SQL_SYNTAX steps\.yaml#\/3\/spec\/handler\/steps\/1\/sql: SQL 2:/)]);
  expect(
    await one({
      steps: [
        { sql: `${log} -- first` },
        { sql: "UPDATE contacts\n  SET nickname = input.name WHERE client_id = input.client" },
      ],
    }),
  ).toEqual([
    expect.stringMatching(/^SQL_\w+ steps\.yaml#\/3\/spec\/handler\/steps\/1\/sql: SQL 2:\d+ near "nickname"/),
  ]);

  // onNoRows names a set-op write: a row op already must change exactly one row, a read writes none
  const rowOp =
    "this step is a row op (one-row INSERT … VALUES, or UPDATE/DELETE with WHERE id = …), which already must change exactly one row.";
  expect(await one({ steps: [{ sql: log, onNoRows: "conflict" }] })).toEqual([
    `SQL_SHAPE steps.yaml#/3/spec/handler/steps/0/onNoRows: Procedure 'p' handler.steps[0].onNoRows applies to a set-op write; ${rowOp}`,
  ]);
  expect(
    await one({
      steps: [
        { sql: create },
        { sql: "UPDATE contacts SET name = input.name WHERE id = input.client", onNoRows: "conflict" },
      ],
    }),
  ).toEqual([
    `SQL_SHAPE steps.yaml#/3/spec/handler/steps/1/onNoRows: Procedure 'p' handler.steps[1].onNoRows applies to a set-op write; ${rowOp}`,
  ]);
  expect(
    await one({
      steps: [{ sql: create }, { sql: "SELECT id FROM contacts WHERE client_id = input.client", onNoRows: "conflict" }],
    }),
  ).toEqual([
    'SQL_SHAPE steps.yaml#/3/spec/handler/steps/1/sql: SQL 1:1 near "SELECT": a Procedure statement is a write',
  ]);
  expect(await one({ steps: [{ sql: create, onNoRows: "conflict" }] })).toEqual([]);
});

test("a named step's row conflict reaches REST and MCP as fields.step beside kind (#1974)", async () => {
  const trigger = (name: string, source: object) => m("Trigger", name, { source, target: { procedure: "add_named" } });
  const files = await generateOrThrow("bun-sqlite", [
    {
      sourceId: "steps.yaml",
      text: [
        text,
        trigger("add-named-http", { kind: "http", method: "POST", path: "/api/named" }),
        trigger("add-named-mcp", { kind: "mcp", surface: "public" }),
      ].join("\n---\n"),
    },
  ]);
  const dir = await mkdtemp(resolve(import.meta.dir, "apps/.generated/steps-wire-")),
    db = new Database(":memory:"),
    caller = fixtureCaller({
      kind: "user",
      subject: "a",
      role: null,
      admin: false,
      scopes: ["mcp"],
      credential: "oauth",
      credentialId: null,
      clientId: null,
    });
  try {
    await writeGenerated(dir, files);
    db.exec(files["schema.sql"]!);
    const { rest } = await import(resolve(dir, "rest.ts")),
      { mcp } = await import(resolve(dir, "mcp.ts"));
    const api = rest({ db: () => db, caller: async () => caller }),
      tools = mcp({ db: () => db, caller: () => caller });
    const client = db
      .query("INSERT INTO clients(id,version,created_at,updated_at,name) VALUES ('c',1,0,0,'acme')")
      .run();
    expect(client.changes).toBe(1);
    for (const [input, step] of [
      [{ client: "missing", name: "n" }, "contact"],
      [{ client: "c", name: "blocked" }, "audit"],
    ] as const) {
      const response = await api(
        new Request("https://app.test/api/named", {
          method: "POST",
          body: JSON.stringify(input),
        }),
        {},
      );
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ error: { code: "CONFLICT", kind: "row", step } });
      const called = await tools(
        new Request("https://app.test/mcp", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: { name: "add_named", arguments: input },
          }),
        }),
        {},
      );
      const body = await called.text(),
        result = JSON.parse(body.startsWith("event:") ? body.split("data: ")[1]!.split("\n")[0]! : body).result;
      expect(result.isError).toBe(true);
      expect(JSON.parse(result.content[0].text).diagnostics[0]).toMatchObject({ code: "CONFLICT", kind: "row", step });
    }
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

for (const pg of [false, true])
  (pg && !process.env.MANTLE_NEXT_BUN_PG_URL ? test.skip : test)(
    `steps: onNoRows: conflict is CONFLICT kind row and rolls the program back (${pg ? "PostgreSQL" : "SQLite"})`,
    async () => {
      const files = await generateOrThrow(pg ? "bun-postgres" : "bun-sqlite", [{ sourceId: "steps.yaml", text }]);
      const dir = await mkdtemp(resolve(import.meta.dir, "apps/.generated/steps-")),
        namespace = "steps_" + crypto.randomUUID().replaceAll("-", "");
      const db: any = pg ? new SQL(process.env.MANTLE_NEXT_BUN_PG_URL!, { max: 1 }) : new Database(":memory:");
      try {
        await writeGenerated(dir, files);
        const app = await import(resolve(dir, "generated.ts"));
        if (pg) {
          await db.unsafe(`CREATE SCHEMA ${namespace}`);
          await db.unsafe(`SET search_path TO ${namespace}`);
          await db.unsafe(files["schema.sql"]!);
        } else db.exec(files["schema.sql"]!);
        await verifyProcedureSteps(app, db, userCaller({ id: "a" }, {}), async (sql: string) => [
          ...(await (pg ? db.unsafe(sql) : Promise.resolve(db.query(sql).all()))),
        ]);
      } finally {
        if (pg) {
          await db.unsafe(`DROP SCHEMA IF EXISTS ${namespace} CASCADE`);
          await db.close();
        } else db.close();
        await rm(dir, { recursive: true, force: true });
      }
    },
  );

(process.env.MANTLE_NEXT_REST_D1 ? test : test.skip)(
  "steps: onNoRows: conflict is CONFLICT kind row and rolls the batch back (local D1)",
  async () => {
    const { unstable_splitSqlQuery } = await import("wrangler"),
      files = await generateOrThrow("cloudflare-d1", [{ sourceId: "steps.yaml", text }]);
    const dir = await mkdtemp(resolve(import.meta.dir, "apps/.generated/steps-d1-"));
    try {
      await writeGenerated(dir, files);
      expect(
        await verifyOnLocalD1(
          dir,
          `import {userCaller} from ${JSON.stringify(resolve(import.meta.dir, "../src/kernel/user-caller.ts"))};
import * as app from './generated.js';
import {verifyProcedureSteps} from ${JSON.stringify(resolve(import.meta.dir, "procedure-steps-scenarios.ts"))};
export default{async fetch(request:Request,env:{DB:any}){if(new URL(request.url).pathname==='/health')return new Response('ready');try{for(const sql of ${JSON.stringify(unstable_splitSqlQuery(files["schema.sql"]!))})await env.DB.prepare(sql).run();
await verifyProcedureSteps(app,env.DB,userCaller({id:"a"},{}),async sql=>(await env.DB.prepare(sql).all()).results);return Response.json({ok:true});}catch(error){return Response.json({error:String(error)},{status:500});}}};`,
          process.env.MANTLE_NEXT_STEPS_D1_PORT ?? "8996",
        ),
      ).toEqual({ ok: true });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
  90000,
);
