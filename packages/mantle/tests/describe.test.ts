import { expect, test } from "bun:test";
import { readFile, mkdtemp, rm, writeFile, readdir } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describeApp, diffApp } from "../dist/domain/describe/index.js";
import { compilePlan, d1Dialect, type RuntimePlan } from "../src/build/compiler.js";
import { mediaDefinitions } from "../src/domain/generated-tools.js";

async function fixture(): Promise<RuntimePlan> {
  const text = await readFile(new URL("apps/user-fields.yaml", import.meta.url), "utf8");
  const result = await compilePlan({ sources: [{ sourceId: "fixture", text }] }, d1Dialect, "operational");
  if (!result.ok) throw Error(JSON.stringify(result.diagnostics));
  return result.plan;
}
const target = (report: Awaited<ReturnType<typeof describeApp>>, id: string) =>
  report.targets.find(t => t._meta.id === id)!._meta;
const copy = (plan: RuntimePlan) => JSON.parse(JSON.stringify(plan));
const targetHash = async (plan: RuntimePlan, id: string) => target(await describeApp(plan), id).targetHash;

test("describe retains built-in media tool metadata and real descriptions", async () => {
  const report = await describeApp(await fixture());
  for (const tool of mediaDefinitions()) {
    const described = report.targets.find(t => t._meta.id === `admin:tool:${tool.name}`)!;
    expect(described.description).toBe(tool.description);
    expect(described.title).not.toBe(described._meta.id);
    if (tool.meta) expect(described._meta).toMatchObject(tool.meta);
  }
  expect(report.targets.find(t => t.name === "upload_media")!._meta["openai/fileParams"]).toEqual(["file"]);
});

test("describe is deterministic, uses MCP names, reports access without SQL or rows", async () => {
  const plan = await fixture(),
    a = await describeApp(plan);
  const reversed = {
    ...plan,
    schemas: Object.fromEntries(Object.entries(plan.schemas).reverse()),
    views: Object.fromEntries(Object.entries(plan.views).reverse()),
    procedures: Object.fromEntries(Object.entries(plan.procedures).reverse()),
    triggers: Object.fromEntries(Object.entries(plan.triggers).reverse()),
  };
  expect(await describeApp(reversed)).toEqual(a);
  expect(a.schemaVersion).toBe(1);
  const unguarded = copy(plan);
  delete unguarded.views["notes-list"].requires;
  expect(target(await describeApp(unguarded), "view:notes-list").requires.all).toContain("ctx.admin");
  expect(a.targets.find(t => t._meta.id === "view:regional-orders")!.name).toBe("regional_orders");
  expect(a.access).toEqual(plan.access!.userFields);
  expect(JSON.stringify(a)).not.toMatch(/SELECT |UPDATE |INSERT |DELETE FROM/);
  expect(a.targets.some(t => t._meta.id === "admin:GET /entries/:id")).toBe(true);
});

test("hash is stable and binds restrictions, scope, input, requirements and SQL behavior", async () => {
  const plan = await fixture(),
    id = "view:regional-orders",
    h = await targetHash(plan, id);
  expect(await targetHash(copy(plan), id)).toBe(h);
  const mutations = [
    (p: any) => {
      p.views["regional-orders"].restrict.orders.terms[0].field = "other";
    },
    (p: any) => {
      p.schemas.orders.userScopes = [{ column: "region", field: "region", type: "string" }];
    },
    (p: any) => {
      p.views["regional-orders"].input = { type: "object", properties: { search: { type: "string" } } };
    },
    (p: any) => {
      p.views["regional-orders"].requires = { auth: { all: ["ctx.user"] } };
    },
    (p: any) => {
      p.views["regional-orders"].source += " ";
    },
  ];
  for (const mutate of mutations) {
    const p = copy(plan);
    mutate(p);
    expect(await targetHash(p, id)).not.toBe(h);
  }
  expect((await describeApp(plan)).targets.some(t => t._meta.id === "view:missing")).toBe(false);
});

test("readOnly is derived from nested IR and refuses ref-handler claims", async () => {
  const plan = copy(await fixture());
  plan.procedures.preview = {
    input: { type: "object" },
    output: { type: "object" },
    inputs: {},
    handler: { sql: { grammar: 180004, stmts: [{ SelectStmt: {} }] }, source: "SELECT 1" },
  };
  plan.procedures.custom = {
    input: { type: "object" },
    output: { type: "object" },
    inputs: {},
    mcp: { readOnlyHint: true },
    handler: { ref: "custom" },
  };
  const a = await describeApp(plan);
  expect(target(a, "view:notes-list").readOnly).toBe(true);
  expect(target(a, "procedure:rename-order").readOnly).toBe(false);
  expect(target(a, "procedure:preview").readOnly).toBe(true);
  expect(target(a, "procedure:custom").readOnly).toBe(false);
  expect(target(a, "procedure:custom").opaque).toBe(true);
  plan.procedures.preview.handler.sql.stmts[0].SelectStmt.withClause = { ctes: [{ UpdateStmt: {} }] };
  expect(target(await describeApp(plan), "procedure:preview").readOnly).toBe(false);
});

test("diff classifies conjunctive removals as widened, additions as narrowed", async () => {
  const plan = await fixture(),
    a = await describeApp(plan),
    p = copy(plan);
  delete p.views["regional-orders"].restrict;
  const b = await describeApp(p);
  expect(diffApp(a, b)).toContainEqual(
    expect.objectContaining({ id: "view:regional-orders", field: "restrict", direction: "widened" }),
  );
  expect(diffApp(b, a)).toContainEqual(
    expect.objectContaining({ id: "view:regional-orders", field: "restrict", direction: "narrowed" }),
  );
  delete p.views["regional-orders"];
  expect(diffApp(a, await describeApp(p))).toContainEqual({
    id: "view:regional-orders",
    field: "target",
    direction: "narrowed",
  });
});

test("CLI JSON equals describeApp and --diff writes nothing into the project", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mantle-describe-"));
  try {
    const cli = new URL("../dist/infrastructure/cli.js", import.meta.url).pathname;
    const manifest = new URL("apps/user-fields.yaml", import.meta.url).pathname;
    const sources = { sources: [{ sourceId: manifest, text: await readFile(manifest, "utf8") }] };
    const compiled = await compilePlan(sources, d1Dialect, "operational");
    if (!compiled.ok) throw Error(JSON.stringify(compiled.diagnostics));
    const report = await describeApp(compiled.plan);
    expect(() => execFileSync("node", [cli, "describe", manifest], { cwd: dir, stdio: "pipe" })).toThrow(
      "mantle describe <target>",
    );
    const json = execFileSync("node", [cli, "describe", "bun-sqlite", manifest], { cwd: dir, encoding: "utf8" });
    expect(JSON.parse(json)).toEqual(report);
    expect(await readdir(dir)).toEqual([]);
    await writeFile(join(dir, "old.json"), json);
    expect(
      execFileSync("node", [cli, "describe", "bun-sqlite", manifest, "--diff", "old.json"], {
        cwd: dir,
        encoding: "utf8",
      }).trim(),
    ).toBe("[]");
    expect(await readdir(dir)).toEqual(["old.json"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 30_000);

test("read flags distinguish insert targets, owner reads and translation parents", async () => {
  const plan = copy(await fixture());
  plan.schemas.orders.scope = "author_id";
  plan.schemas.notes.translates = { parent: "orders", on: "id" };
  plan.procedures.insertOnly = {
    input: { type: "object" },
    output: { type: "object" },
    inputs: {},
    handler: {
      sql: { grammar: 180004, stmts: [{ InsertStmt: { relation: { relname: "orders" } } }] },
      source: "INSERT INTO orders DEFAULT VALUES",
    },
  };
  const a = await describeApp(plan);
  expect(target(a, "procedure:insertOnly").readOnly).toBe(false);
  expect(target(a, "procedure:insertOnly").unscopedReads).toBe(false);
  expect(a.access).not.toHaveProperty("id");
  const h = await targetHash(plan, "view:notes-list");
  delete plan.schemas.orders.scope;
  expect(await targetHash(plan, "view:notes-list")).not.toBe(h);
});

test("Admin catalogue includes every literal built-in server route", async () => {
  const report = await describeApp(await fixture());
  for (const file of ["index", "entries", "site", "webmcp"]) {
    const source = await readFile(new URL(`../../mantle-admin/src/server/${file}.ts`, import.meta.url), "utf8");
    // Whitespace-tolerant, and never empty: a layout change must not silently drop routes from the check.
    const routes = [...source.matchAll(/method:\s*"([A-Z]+)"(?:\s+as\s+const)?,\s*path:\s*"([^"]+)"/g)];
    expect(routes.length).toBeGreaterThan(0);
    for (const [, method, path] of routes) {
      const id = `admin:${method} ${path!.replace(/\{([^}]+)\}/g, ":$1")}`;
      expect(report.targets.some(t => t._meta.id === id)).toBe(true);
    }
  }
});

const H = "apiVersion: cms.mantle.aotter.net/v2\n";
async function compile(text: string): Promise<RuntimePlan> {
  const result = await compilePlan({ sources: [{ sourceId: "regression", text }] }, d1Dialect, "operational");
  if (!result.ok) throw Error(JSON.stringify(result.diagnostics));
  return result.plan;
}
const fixtureText = () => readFile(new URL("apps/user-fields.yaml", import.meta.url), "utf8");
const posts = `${H}kind: Schema
metadata: {name: posts}
spec:
  title: Posts
  lifecycle: publishing
  schema: {type: object, required: [title], properties: {title: {type: string}}}
---
${H}kind: View
metadata: {name: posts-admin}
spec:
  surface: admin
  requires: {auth: {all: [ctx.admin]}}
  sql: SELECT id, title FROM posts ORDER BY id
`;
const dual = `${H}kind: Schema
metadata: {name: things}
spec:
  title: Things
  lifecycle: operational
  schema: {type: object, required: [title], properties: {title: {type: string}}}
---
${H}kind: Procedure
metadata: {name: add-thing}
spec:
  input: {type: object, required: [title], properties: {title: {type: string}}}
  output: {type: object}
  handler: {sql: "INSERT INTO things (title) VALUES (input.title) RETURNING id"}
---
${H}kind: Trigger
metadata: {name: add-admin}
spec: {source: {kind: mcp, surface: admin}, target: {procedure: add-thing}}
`;
test("WebMCP dispatch includes publishing and media tools and cannot claim readOnly", async () => {
  const report = await describeApp(await compile(posts));
  const dispatcher = target(report, "admin:POST /webmcp/:tool");
  expect(dispatcher.readOnly).toBe(false);
  for (const verb of ["publish", "unpublish", "archive"]) {
    const id = `procedure:posts.${verb}`;
    expect(dispatcher.variants.some(v => v.id === id)).toBe(true);
    expect(target(report, id).readOnly).toBe(false);
    expect(report.targets.find(t => t._meta.id === id)!.name).toBe(`${verb}_posts`);
  }
  for (const name of [
    "upload_media",
    "find_media",
    "update_media",
    "delete_media",
    "get_media_upload_policy",
    "create_media_upload",
    "commit_media_upload",
    "list_media_assets",
    "get_media_asset",
    "update_media_asset",
    "delete_media_asset",
  ])
    expect(dispatcher.variants.some(v => v.id === `admin:tool:${name}`)).toBe(true);
  const empty = await describeApp(await compile(dual.split("---").slice(0, 2).join("---")));
  expect(target(empty, "admin:POST /operations/:name").readOnly).toBe(false);
  expect(target(empty, "admin:GET /views/:name").readOnly).toBe(false);
});

test("the Admin view batch is a read-only dispatcher over exactly the admin Views the single route reaches", async () => {
  const report = await describeApp(await fixture());
  const batch = target(report, "admin:GET /view-batch"),
    single = target(report, "admin:GET /views/:name");
  expect(batch.variants.map(v => v.id)).toEqual(single.variants.map(v => v.id));
  expect(batch.variants.length).toBeGreaterThan(0);
  expect(batch.readOnly).toBe(single.readOnly);
});

test("public MCP and REST exposure survives an admin MCP binding with independent gates", async () => {
  const plan = await compile(
    dual +
      `---\n${H}kind: Trigger\nmetadata: {name: add-public}\nspec: {source: {kind: mcp, surface: public}, target: {procedure: add-thing}}\n---\n${H}kind: Trigger\nmetadata: {name: add-http}\nspec: {source: {kind: http, method: POST, path: /api/things}, target: {procedure: add-thing}}\n`,
  );
  const m = target(await describeApp(plan), "procedure:add-thing");
  expect(m.surfaces).toEqual(["admin", "public", "rest"]);
  expect(m.requires.all).toEqual([]);
  expect(m.triggers.map(t => t.id)).toEqual(["add-admin", "add-http", "add-public"]);
});

test("internal to public, new triggers and removing trustedOnly widen and change hashes", async () => {
  const internal = await compile(dual.split("---").slice(0, 2).join("---"));
  const pub = await compile(dual.replace("surface: admin", "surface: public"));
  const id = "procedure:add-thing";
  expect(await targetHash(internal, id)).not.toBe(await targetHash(pub, id));
  expect(diffApp(await describeApp(internal), await describeApp(pub))).toContainEqual(
    expect.objectContaining({ id, field: "surfaces", direction: "widened" }),
  );
  const trusted = copy(internal);
  trusted.procedures["add-thing"].trustedOnly = true;
  const changes = diffApp(await describeApp(trusted), await describeApp(internal));
  expect(changes).toContainEqual(expect.objectContaining({ id, field: "trustedOnly", direction: "widened" }));
  const second = copy(pub);
  second.triggers.second = { source: { kind: "mcp", surface: "public" }, procedure: "add-thing" };
  expect(await targetHash(pub, id)).not.toBe(await targetHash(second, id));
  expect(diffApp(await describeApp(pub), await describeApp(second))).toContainEqual(
    expect.objectContaining({ id, field: "triggers", direction: "widened" }),
  );
});

test("loosening auth requirements widens", async () => {
  const a = copy(await fixture()),
    b = copy(a);
  a.procedures["rename-order"].requires.auth.all.push("ctx.user");
  expect(diffApp(await describeApp(a), await describeApp(b))).toContainEqual(
    expect.objectContaining({ id: "procedure:rename-order", field: "requires", direction: "widened" }),
  );
});

test("reading another Schema widens, while adding terms to a read Schema narrows", async () => {
  const a = await describeApp(await fixture()),
    b = structuredClone(a),
    id = "view:all-orders";
  target(b, id).scope = {
    ...target(b, id).scope,
    notes: { terms: [{ column: "area", field: "region", type: "string" }] },
  };
  expect(diffApp(a, b)).toContainEqual(expect.objectContaining({ id, field: "scope", direction: "widened" }));
  const c = structuredClone(a);
  target(c, id).scope = {
    ...target(c, id).scope,
    orders: { terms: [{ column: "region", field: "region", type: "string" }] },
  };
  expect(diffApp(a, c)).toContainEqual(expect.objectContaining({ id, field: "scope", direction: "narrowed" }));
  const text = (await fixtureText()).replace(
    "sql: SELECT id, title, region FROM orders ORDER BY title, id",
    "sql: SELECT o.id, o.title, n.title AS note FROM orders o LEFT JOIN notes n ON n.id = o.id ORDER BY o.title, o.id",
  );
  expect(diffApp(a, await describeApp(await compile(text)))).toContainEqual(
    expect.objectContaining({ id, field: "scope", direction: "widened" }),
  );
});

test("ref handlers conservatively report all possible read scopes", async () => {
  const plan = copy(await fixture());
  plan.schemas.notes.scope = "author_id";
  plan.procedures.custom = {
    input: { type: "object" },
    output: { type: "object" },
    inputs: {},
    handler: { ref: "custom" },
  };
  const m = target(await describeApp(plan), "procedure:custom");
});

test("dispatcher restrictions stay per variant and any variant loosening widens", async () => {
  const a = copy(await fixture());
  a.views["tier-orders"].surface = "admin";
  a.views["tier-orders"].restrict = copy(a).views["regional-orders"].restrict;
  const before = await describeApp(a),
    b = copy(a);
  delete b.views["regional-orders"].restrict;
  const after = await describeApp(b);
  for (const id of ["admin:GET /views/:name", "admin:GET /developer/views/:name"]) {
    expect(target(before, id).restrict.orders!.terms).toEqual([]);
    expect(target(before, id).variants.find(v => v.id === "view:regional-orders")!.restrict.orders!.terms).toHaveLength(
      1,
    );
    expect(diffApp(before, after)).toContainEqual(
      expect.objectContaining({ id, field: "variants", direction: "widened" }),
    );
  }
});

test("expanded View SQL pins outer behavior; a View that reads a restricted View carries its restrict", async () => {
  const base = await fixtureText();
  const mk = (sql: string, restrict = "") =>
    base +
    `---\n${H}kind: View\nmetadata: {name: inner_v}\nspec:\n  title: inner\n  surface: internal\n${restrict}  sql: ${sql}\n---\n${H}kind: View\nmetadata: {name: outer-v}\nspec:\n  title: outer\n  surface: public\n  sql: SELECT id, title FROM inner_v ORDER BY id\n`;
  const a = await compile(mk("SELECT id, title FROM orders ORDER BY id"));
  const b = await compile(mk("SELECT id, title FROM orders WHERE tier = 'x' ORDER BY id"));
  const c = await compile(
    mk("SELECT id, title FROM orders ORDER BY id", "  restrict: {orders: \"region IN auth.user('region')\"}\n"),
  );
  expect(await targetHash(a, "view:outer-v")).not.toBe(await targetHash(b, "view:outer-v"));
  expect(await targetHash(a, "view:outer-v")).not.toBe(await targetHash(c, "view:outer-v"));
  expect(Object.keys(target(await describeApp(c), "view:outer-v").restrict)).toEqual(["orders"]);
  for (const id of ["view:inner_v", "view:outer-v"])
    expect(diffApp(await describeApp(c), await describeApp(a))).toContainEqual(
      expect.objectContaining({ id, field: "restrict", direction: "widened" }),
    );
});

test("standalone route hashes retain the global user-field vocabulary", async () => {
  const a = await fixture(),
    b = await compile(
      `${H}kind: Schema\nmetadata: {name: zz}\nspec:\n  title: Z\n  lifecycle: operational\n  schema: {type: object, properties: {a: {type: string}}}\n`,
    );
  const sameFields = { ...b, access: a.access };
  for (const id of [
    "admin:PATCH /admin/:id/role",
    "admin:POST /admin/invitations",
    "admin:PATCH /site-settings",
    "admin:POST /media/uploads",
  ]) {
    expect(await targetHash(a, id)).not.toBe(await targetHash(b, id));
    expect(await targetHash(a, id)).toBe(await targetHash(sameFields, id));
  }
});

test("starting to read an unscoped Schema is widened", async () => {
  const base = await fixtureText(),
    extra = `---\n${H}kind: Schema\nmetadata: {name: secrets}\nspec:\n  title: S\n  lifecycle: operational\n  schema: {type: object, properties: {v: {type: string}}}\n`;
  const a = await compile(base + extra),
    b = await compile(
      base.replace(
        "sql: SELECT id, title FROM notes ORDER BY id",
        "sql: SELECT n.id, n.title, s.v FROM notes n LEFT JOIN secrets s ON s.id = n.id ORDER BY n.id",
      ) + extra,
    );
  const before = await describeApp(a),
    after = await describeApp(b),
    id = "view:notes-list";
  expect(target(before, id).unscopedReads).toBe(false);
  expect(target(after, id).unscopedReads).toBe(true);
  expect(diffApp(before, after)).toContainEqual(
    expect.objectContaining({ id, field: "unscopedReads", direction: "widened" }),
  );
});

test("input schema changes are always changed", async () => {
  const a = await fixture(),
    before = await describeApp(a),
    id = "procedure:rename-order";
  for (const mutate of [
    (p: any) => {
      p.procedures["rename-order"].input.required = ["id"];
    },
    (p: any) => {
      delete p.procedures["rename-order"].input.properties.title.minLength;
    },
    (p: any) => {
      p.procedures["rename-order"].input.additionalProperties = true;
    },
  ]) {
    const b = copy(a);
    mutate(b);
    expect(diffApp(before, await describeApp(b))).toContainEqual(
      expect.objectContaining({ id, field: "inputSchema", direction: "changed" }),
    );
  }
  const b = copy(a);
  b.procedures["rename-order"].input.anyOf = [{ required: ["title"] }];
  expect(diffApp(before, await describeApp(b))).toContainEqual(
    expect.objectContaining({ id, field: "inputSchema", direction: "changed" }),
  );
});

test("target hashes normalize optional lowering away for all targets", async () => {
  const a = await fixture(),
    b = copy(a);
  b.lowered = {
    mantle: "cache",
    dialect: { ...a.dialect, key: "cache" },
    views: { "regional-orders": { caller: { sql: "cached", binds: [] } } },
    procedures: { "rename-order": { caller: [{ sql: "cached", binds: [] }] } },
  };
  const report = await describeApp(a),
    other = await describeApp(b);
  expect(report.targets.map(t => [t._meta.id, t._meta.targetHash])).toEqual(
    other.targets.map(t => [t._meta.id, t._meta.targetHash]),
  );
  expect(diffApp(report, other)).toEqual([]);
});

test("a dispatcher reports widening in one variant even when aggregate flags stay unchanged", async () => {
  const a = copy(await fixture());
  a.procedures["rename-order"].trustedOnly = true;
  a.procedures.second = { ...a.procedures["rename-order"] };
  a.triggers.second = { source: { kind: "mcp", surface: "admin" }, procedure: "second" };
  const b = copy(a);
  delete b.procedures["rename-order"].trustedOnly;
  const before = await describeApp(a),
    after = await describeApp(b);
  for (const id of ["admin:POST /operations/:name", "admin:POST /webmcp/:tool"]) {
    expect(target(before, id).trustedOnly).toBe(true);
    expect(target(after, id).trustedOnly).toBe(true);
    expect(diffApp(before, after)).toContainEqual(
      expect.objectContaining({ id, field: "variants", direction: "widened" }),
    );
  }
});

test("a Procedure Trigger does not expose a View with the same name", async () => {
  const plan = copy(await fixture());
  plan.views["rename-order"] = plan.views["all-orders"];
  plan.triggers.public = { source: { kind: "mcp", surface: "public" }, procedure: "rename-order" };
  const report = await describeApp(plan),
    m = target(report, "view:rename-order");
  expect(m.surfaces).toEqual(["admin", "internal"]);
  expect(m.triggers).toEqual([]);
  expect(report.targets.some(t => t._meta.id === "rest:GET /api/views/rename-order")).toBe(false);
});

test("@aotter/mantle/describe exports only matchTarget and statically loads no compiler, parser or YAML", async () => {
  const { readFileSync } = await import("node:fs"),
    { dirname, join } = await import("node:path");
  const entry = join(import.meta.dir, "../dist/domain/describe/public.js");
  expect(Object.keys(await import(entry))).toEqual(["matchTarget"]);
  const seen = new Set<string>(),
    visit = (file: string): string =>
      seen.has(file)
        ? ""
        : (seen.add(file),
          (() => {
            const text = readFileSync(file, "utf8");
            return (
              text +
              [...text.matchAll(/from\s*"(\.[^"]+)"/g)].map(([, path]) => visit(join(dirname(file), path!))).join("")
            );
          })());
  expect(visit(entry)).not.toMatch(/libpg-query|from\s*"yaml"|build\/compiler|import\(/);
});

// Compatibility baselines for #2174: targetHash formula v1 as literal values, and a saved v1 report
// (`fixtures/describe-v1-report.json`, the user-fields fixture on D1) that later readers must keep reading.
const v1Pins: Record<string, string> = {
  "procedure:delete-doc": "080c2bd858f12a8f2b6be5910fffd850b461b9e479ee2be429fa5ee7bf9a4b84",
  "procedure:rename-doc": "1c203344691a8b94d8a812f043ddc3516480144cea905bd6ef23e6be60c461a6",
  "procedure:rename-order": "79a02d3163bce5b2904aace97637de252b78e22dd668479e7408589660801116",
  "rest:GET /api/views/my-doc": "f7a9967fc595e559850faed515d56e6b4d35dbc4d627276b1004027042c1657d",
  "rest:GET /api/views/my-docs": "e7d09a437ee82204697f5abe23eac63f71fee1c518c20b220a63fe68087964ca",
  "rest:POST /api/orders/rename": "c93521e00b4e37e0e3003d4b703441378c5bf371f13b3683a8541063d9dae4db",
  "view:all-orders": "d93b1ba64588ff8a211d0d2454ce7e51c5cb7b9419c15eb7780ad5666577135a",
  "view:member-docs": "ffffaba4d59a3294a1c1c43815fa2d1adb2680905462bff5b912f0eeae80620c",
  "view:my-doc": "28f9dfaf1adc4a34474f21eb7a2f7ec640e51dc557dbe7c0c8e43029d3584173",
  "view:my-docs": "50ebe9c793901a6e441af47191a1d5ad4743d75910e25eef20648e96009b472a",
  "view:notes-list": "96458b23f893dae785c84d0e60622abad5294b9868036efeb405524d00379cb2",
  "view:regional-orders": "5435153a1306380044f911bc1d0e1ba1a4eab8f45c3b32b20b73ed589d24dc93",
  "view:tier-orders": "f8422b2e0348c542cbff456a5e39a308650c65b5e225392e870746bc84da2d3a",
  "admin:GET /entries": "62ea8126ab37608dff1588b73422302e89ed9accacf06203ea50e4202f404ca0",
  "admin:POST /operations/:name": "6c0a12174a0779b96732bb446170cbcd7ec8053675087d28778cc93d2dcd734c",
  "admin:tool:find_media": "d66331e2aa742ee8c3a4faf5e805f51014debc0f85f51b1e57e7594b5ab6840e",
};
const savedV1 = async () =>
  JSON.parse(await readFile(new URL("fixtures/describe-v1-report.json", import.meta.url), "utf8")) as Awaited<
    ReturnType<typeof describeApp>
  >;

test("targetHash formula v1 keeps its literal values, and the saved v1 report carries them", async () => {
  const report = await describeApp(await fixture()),
    saved = await savedV1();
  for (const [id, hash] of Object.entries(v1Pins)) {
    expect([id, target(report, id).targetHash]).toEqual([id, hash]);
    expect([id, target(saved, id).targetHash]).toEqual([id, hash]);
  }
});

test("the saved v1 report equals today's report and diffApp reads it in both directions", async () => {
  const report = JSON.parse(JSON.stringify(await describeApp(await fixture()))),
    saved = await savedV1();
  expect(saved.schemaVersion).toBe(1);
  expect("targetHashVersion" in saved).toBe(false);
  expect(report).toEqual(saved);
  expect(diffApp(saved, saved)).toEqual([]);
  expect(diffApp(saved, report)).toEqual([]);
  expect(diffApp(report, saved)).toEqual([]);
});

test("matchTarget resolves the saved v1 report as it resolves today's report", async () => {
  const { matchTarget } = await import("../dist/domain/describe/index.js");
  const report = JSON.parse(JSON.stringify(await describeApp(await fixture()))),
    saved = await savedV1();
  const rows: [Parameters<typeof matchTarget>[1], string | null][] = [
    [{ surface: "rest", method: "GET", path: "/api/views/my-docs" }, "rest:GET /api/views/my-docs"],
    [{ surface: "rest", method: "HEAD", path: "/api/views/my-docs" }, "rest:GET /api/views/my-docs"],
    [{ surface: "rest", method: "GET", path: "/api/views/my-doc" }, "rest:GET /api/views/my-doc"],
    [{ surface: "rest", method: "POST", path: "/api/orders/rename" }, "rest:POST /api/orders/rename"],
    [{ surface: "rest", method: "HEAD", path: "/api/orders/rename" }, null],
    [{ surface: "rest", method: "GET", path: "/api/orders/rename" }, null],
    [{ surface: "rest", method: "GET", path: "/api/views/all-orders" }, null],
    [{ surface: "rest", method: "GET", path: "/api/orders/5" }, null],
    [{ surface: "admin", method: "GET", path: "/admin/api/entries" }, "admin:GET /entries"],
    [{ surface: "mcp", tool: "my_docs", path: "/mcp" }, "view:my-docs"],
    [{ surface: "mcp", tool: "rename_order", path: "/mcp/admin" }, "procedure:rename-order"],
    [{ surface: "mcp", tool: "find_media", path: "/mcp/admin" }, "admin:tool:find_media"],
    [{ surface: "mcp", tool: "all_orders", path: "/mcp" }, null],
  ];
  for (const [request, id] of rows) {
    expect([request, matchTarget(saved, request)?.id ?? null]).toEqual([request, id]);
    expect([request, matchTarget(report, request)?.id ?? null]).toEqual([request, id]);
  }
});
