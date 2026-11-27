/** Diff directions and hash stability found by review. */
import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
const { describeApp, diffApp } = await import("../src/domain/describe/index.js");
const { compilePlan, d1Dialect } = await import("../src/build/compiler.js");
const H = "apiVersion: cms.mantle.aotter.net/v2\n";
async function compile(text: string) {
  const r = await compilePlan({ sources: [{ sourceId: "x", text }] }, d1Dialect, "operational");
  if (!r.ok) throw Error(JSON.stringify(r.diagnostics.filter((d: any) => d.severity === "error")));
  return r.plan;
}
const base = await readFile(new URL("apps/user-fields.yaml", import.meta.url), "utf8");
const meta = (r: any, id: string) => r.targets.find((t: any) => t._meta.id === id)?._meta;
const copy = (p: any) => JSON.parse(JSON.stringify(p));
const targetHash = async (p: any, id: string) => meta(await describeApp(p), id).targetHash;
const dirs = (c: any[], id: string) => c.filter(x => x.id === id).map(x => [x.field, x.direction]);

test("diff: swapping a restrict term (region for tier) is widened", async () => {
  const a = await compile(base);
  const b = await compile(
    base.replace(
      `restrict: {orders: "region IN auth.user('region')"}\n  sql: SELECT id, title, region`,
      `restrict: {orders: "tier IN auth.user('tier')"}\n  sql: SELECT id, title, region`,
    ),
  );
  const c = diffApp(await describeApp(a), await describeApp(b));
  expect(dirs(c, "view:regional-orders").some(([, d]: any) => d === "widened")).toBe(true);
});

test("targetHash does not depend on the process locale", async () => {
  const p = await compile(
    base +
      `---\n${H}kind: Trigger\nmetadata: {name: rename-y}\nspec: {source: {kind: http, method: POST, path: /api/y}, target: {procedure: rename-order}}\n---\n${H}kind: Trigger\nmetadata: {name: rename-j}\nspec: {source: {kind: http, method: POST, path: /api/j}, target: {procedure: rename-order}}\n`,
  );
  const en = await targetHash(p, "procedure:rename-order");
  const orig = String.prototype.localeCompare;
  String.prototype.localeCompare = function (this: string, that: string) {
    return orig.call(this, that, "lt");
  } as any;
  try {
    const lt = await targetHash(p, "procedure:rename-order");
    expect(lt).toBe(en);
  } finally {
    String.prototype.localeCompare = orig;
  }
});

// Behavior and exposure fingerprints, targetHash formula 2 (ADR-0047 §7, #2174).
const { presentationFields } = await import("../src/domain/describe/targets.js");
const getDoc = `---\n${H}kind: Trigger\nmetadata: {name: doc-get}\nspec: {source: {kind: http, method: GET, path: "/api/docs/{id}"}, target: {view: my-doc}}\n`;
const withGet = base + getDoc;
type Prints = Map<string, { behavior: string; exposure: string; pin: string }>;
const prints = async (p: any): Promise<Prints> =>
  new Map(
    (await describeApp(p)).targets.map((t: any) => [
      t._meta.id,
      { behavior: t._meta.behaviorHash, exposure: t._meta.exposureHash, pin: t._meta.targetHash },
    ]),
  );
/** Which fingerprints of `id` moved between two reports. */
const moved = (a: Prints, b: Prints, id: string, other = id) => {
  const x = a.get(id)!,
    y = b.get(other)!;
  return { behavior: x.behavior !== y.behavior, exposure: x.exposure !== y.exposure, pin: x.pin !== y.pin };
};
/** Ids present in both reports whose pin changed. */
const pinsMoved = (a: Prints, b: Prints) =>
  [...a.keys()].filter(id => b.has(id) && a.get(id)!.pin !== b.get(id)!.pin).sort();
const same = { behavior: false, exposure: false, pin: false };

test("fingerprints: a path-only move changes only that rest entry's id, exposure and pin", async () => {
  const before = await prints(await compile(withGet));
  const rows: [string, string, string, string][] = [
    ["GET View Trigger", 'path: "/api/docs/{id}"', "rest:GET /api/docs/:id", "rest:GET /api/documents/:id"],
    [
      "POST Procedure Trigger",
      "path: /api/orders/rename",
      "rest:POST /api/orders/rename",
      "rest:POST /api/orders/retitle",
    ],
  ];
  for (const [name, from, oldId, newId] of rows) {
    const to = from.replace(/\/api\/docs|\/api\/orders\/rename/, m =>
      m === "/api/docs" ? "/api/documents" : "/api/orders/retitle",
    );
    const after = await prints(await compile(withGet.replace(from, to)));
    expect([name, after.has(oldId), before.has(newId)]).toEqual([name, false, false]);
    expect([name, moved(before, after, oldId, newId)]).toEqual([name, { behavior: false, exposure: true, pin: true }]);
    expect([name, pinsMoved(before, after)]).toEqual([name, []]);
  }
});

test("fingerprints: behavior, exposure and pin move as ADR-0047 states", async () => {
  const docsStar = `---\n${H}kind: View\nmetadata: {name: all-docs}\nspec:\n  title: All documents\n  surface: public\n  sql: SELECT * FROM documents ORDER BY id\n`;
  const plan = await compile(withGet + docsStar);
  const before = await prints(plan);
  const view = "view:my-doc",
    get = "rest:GET /api/docs/:id",
    builtIn = "rest:GET /api/views/my-doc";
  const behavior = { behavior: true, exposure: false, pin: true };
  const both = { behavior: true, exposure: true, pin: true };
  const exposure = { behavior: false, exposure: true, pin: true };
  const rows: [string, (p: any) => void, Record<string, typeof same>][] = [
    [
      "added projection column",
      p => {
        const v = p.views["my-doc"];
        v.source = v.source.replace("SELECT id, title", "SELECT id, title, org");
        v.stmts[0].SelectStmt.targetList.push(structuredClone(v.stmts[0].SelectStmt.targetList[0]));
      },
      { [view]: behavior, [get]: behavior, [builtIn]: behavior },
    ],
    [
      "SELECT * reads a new Schema field",
      p => {
        p.schemas.documents.schema.properties.pages = { type: "integer" };
      },
      { "view:all-docs": behavior, "rest:GET /api/views/all-docs": behavior },
    ],
    [
      "retyped {id}",
      p => {
        p.views["my-doc"].input.properties.id.type = "integer";
      },
      { [view]: both, [get]: both, [builtIn]: both },
    ],
    [
      "requires",
      p => {
        p.views["my-doc"].requires = { auth: { all: ["ctx.user"] } };
      },
      { [view]: both, [get]: both, [builtIn]: both },
    ],
    [
      "restrict",
      p => {
        p.views["my-doc"].restrict.documents.or = undefined;
      },
      { [view]: behavior, [get]: behavior, [builtIn]: behavior },
    ],
    [
      "description only",
      p => {
        p.views["my-doc"].description = "One document, by id.";
      },
      { [view]: exposure, [get]: same, [builtIn]: same },
    ],
  ];
  for (const [name, mutate, expected] of rows) {
    const p = copy(plan);
    mutate(p);
    const after = await prints(p);
    for (const [id, moves] of Object.entries(expected))
      expect([name, id, moved(before, after, id)]).toEqual([name, id, moves]);
  }
});

test("fingerprints: renaming {k} moves the rest entry's exposure and binding", async () => {
  const a = await describeApp(await compile(withGet)),
    b = await describeApp(
      await compile(
        withGet
          .replace('path: "/api/docs/{id}"', 'path: "/api/docs/{doc}"')
          .replace(
            "required: [id], properties: {id: {type: string}}}",
            "required: [doc], properties: {doc: {type: string}}}",
          )
          .replace(
            "WHERE id = input.id ORDER BY id\n---\n" + H + "kind: View\nmetadata: {name: member-docs}",
            "WHERE id = input.doc ORDER BY id\n---\n" + H + "kind: View\nmetadata: {name: member-docs}",
          ),
      ),
    );
  expect(meta(a, "rest:GET /api/docs/:id").exposure.path).toEqual({ id: "string" });
  expect(meta(b, "rest:GET /api/docs/:doc").exposure.path).toEqual({ doc: "string" });
  expect(meta(b, "rest:GET /api/docs/:doc").exposureHash).not.toBe(meta(a, "rest:GET /api/docs/:id").exposureHash);
  expect(meta(b, "rest:GET /api/docs/:doc").targetHash).not.toBe(meta(a, "rest:GET /api/docs/:id").targetHash);
});

test("fingerprints: a route with one variant shares its behaviorHash; rest entries carry their binding", async () => {
  const report = await describeApp(await compile(withGet));
  for (const [route, variant] of <[string, string][]>[
    ["rest:POST /api/orders/rename", "procedure:rename-order"],
    ["rest:GET /api/docs/:id", "view:my-doc"],
    ["rest:GET /api/views/my-doc", "view:my-doc"],
  ]) {
    expect(meta(report, route).behaviorHash).toBe(meta(report, variant).behaviorHash);
    expect(meta(report, route).exposureHash).not.toBe(meta(report, variant).exposureHash);
  }
  expect(meta(report, "rest:GET /api/docs/:id").exposure).toEqual({
    path: { id: "string" },
    input: "query",
    strict: true,
    head: false,
    response: "page",
  });
  expect(meta(report, "rest:GET /api/views/my-doc").exposure).toEqual({
    path: {},
    input: "query",
    strict: false,
    head: true,
    response: "page",
  });
  expect(meta(report, "rest:POST /api/orders/rename").exposure).toEqual({
    path: {},
    input: "body",
    strict: false,
    head: false,
    response: "result",
  });
  for (const t of report.targets as any[]) {
    expect([t._meta.id, "exposure" in t._meta]).toEqual([t._meta.id, t._meta.id.startsWith("rest:")]);
    for (const key of ["behaviorHash", "exposureHash", "targetHashV1"])
      expect([t._meta.id, key, t._meta[key]]).toEqual([t._meta.id, key, expect.stringMatching(/^[0-9a-f]{64}$/)]);
  }
});

test("fingerprints: presentation is an explicit list that moves exposure, never behavior", async () => {
  expect([...presentationFields]).toEqual(["title", "description", "uiSchema", "mcp"]);
  const plan = await compile(withGet),
    before = await prints(plan);
  const values: Record<(typeof presentationFields)[number], unknown> = {
    title: { en: "Rename", fr: "Renommer" },
    description: "Renames one order.",
    uiSchema: { title: { "ui:widget": "textarea" } },
    mcp: { destructiveHint: false, idempotentHint: true },
  };
  for (const field of presentationFields) {
    const p = copy(plan);
    p.procedures["rename-order"][field] = values[field];
    const after = await prints(p);
    expect([field, moved(before, after, "procedure:rename-order")]).toEqual([field, exposure()]);
    expect([field, moved(before, after, "rest:POST /api/orders/rename")]).toEqual([field, same]);
  }
  // A non-English edit leaves the resolved English text alone; the pin must still see it, as formula 1 did.
  for (const field of ["title", "description"] as const) {
    const a = copy(plan),
      b = copy(plan);
    a.procedures["rename-order"][field] = { en: "Rename", fr: "Renommer" };
    b.procedures["rename-order"][field] = { en: "Rename", fr: "Changer le nom" };
    expect([field, moved(await prints(a), await prints(b), "procedure:rename-order")]).toEqual([field, exposure()]);
  }
  function exposure() {
    return { behavior: false, exposure: true, pin: true };
  }
});
