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
    uiSchema: { fields: { title: { widget: "textarea" } }, collectionAction: "orders" },
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

test("fingerprints: a View list's filterFields and searchFields are behavior; its columns and nav are not", async () => {
  // Admin's generated routes validate `filters`/`search` against these lists and compile them into SQL.
  const plan = await compile(base),
    before = await prints(plan);
  const view = "view:regional-orders";
  const routes = [
    "admin:GET /views/:name",
    "admin:GET /views/:name/export",
    "admin:GET /view-batch",
    "admin:GET /developer/views/:name",
  ];
  const rows: [string, Record<string, unknown>, boolean][] = [
    ["filterFields", { list: { filterFields: ["region"] } }, true],
    ["searchFields", { list: { searchFields: ["title"] } }, true],
    ["columns", { list: { columns: ["title"] } }, false],
    ["nav", { nav: { group: "content", order: 1 } }, false],
  ];
  for (const [name, uiSchema, behavioral] of rows) {
    const p = copy(plan);
    p.views["regional-orders"].uiSchema = uiSchema;
    const after = await prints(p);
    expect([name, moved(before, after, view)]).toEqual([
      name,
      { behavior: behavioral, exposure: true, pin: true },
    ]);
    for (const route of routes)
      expect([name, route, moved(before, after, route)]).toEqual([
        name,
        route,
        { behavior: behavioral, exposure: false, pin: behavioral },
      ]);
  }
});

// diffApp semantics (ADR-0047 §8, #2174).
type Line = [id: string, field: string, direction: string, unverified?: true];
const lines = (c: any[]): Line[] =>
  c.map(x => (x.unverified ? [x.id, x.field, x.direction, x.unverified] : [x.id, x.field, x.direction]));
/** A formula-2 report as a formula-1 reader saved it: no additive keys, `targetHash` read from `targetHashV1`. */
const asFormulaV1 = (report: any) => {
  const { targetHashVersion: _, ...rest } = copy(report);
  for (const t of rest.targets) {
    t._meta.targetHash = t._meta.targetHashV1;
    for (const key of ["targetHashV1", "behaviorHash", "exposureHash", "exposure"]) delete t._meta[key];
  }
  return rest;
};
const projection = (p: any) => {
  const v = p.views["my-doc"];
  v.source = v.source.replace("SELECT id, title", "SELECT id, title, org");
  v.stmts[0].SelectStmt.targetList.push(structuredClone(v.stmts[0].SelectStmt.targetList[0]));
};
const myDocRoutes = ["admin:GET /developer/views/:name", "rest:GET /api/docs/:id", "rest:GET /api/views/my-doc"];
const behaviorLines = (ids: string[]): Line[] => ids.map(id => [id, "behavior", "changed"]);

test("diff: a URI-only REST move is one exposure line; the path-only Trigger move is changed, not widened", async () => {
  const before = await describeApp(await compile(withGet));
  const rows: [string, string, string, string, string, string[]][] = [
    [
      "GET View Trigger",
      'path: "/api/docs/{id}"',
      'path: "/api/documents/{id}"',
      "rest:GET /api/docs/:id",
      "rest:GET /api/documents/:id",
      ["admin:GET /developer/views/:name", "rest:GET /api/views/my-doc", "view:my-doc"],
    ],
    [
      "POST Procedure Trigger",
      "path: /api/orders/rename",
      "path: /api/orders/retitle",
      "rest:POST /api/orders/rename",
      "rest:POST /api/orders/retitle",
      ["admin:POST /operations/:name", "admin:POST /webmcp/:tool", "procedure:rename-order"],
    ],
  ];
  for (const [name, from, to, oldId, newId, carriers] of rows) {
    const changes = diffApp(before, await describeApp(await compile(withGet.replace(from, to))));
    expect([name, changes.find(c => c.id === newId)]).toEqual([
      name,
      {
        id: newId,
        field: "exposure",
        direction: "changed",
        before: oldId,
        after: newId,
      },
    ]);
    const expected: Line[] = [
      ...carriers.map((id): Line => [id, "triggers", "changed"]),
      [newId, "exposure", "changed"],
    ];
    expect([name, lines(changes).sort()]).toEqual([name, expected.sort()]);
  }
});

test("diff: equal URI-only move candidates pair one-to-one in id order", async () => {
  const two = (a: string, b: string) =>
    base +
    `---\n${H}kind: Trigger\nmetadata: {name: rename-a}\nspec: {source: {kind: http, method: POST, path: ${a}}, target: {procedure: rename-order}}\n` +
    `---\n${H}kind: Trigger\nmetadata: {name: rename-b}\nspec: {source: {kind: http, method: POST, path: ${b}}, target: {procedure: rename-order}}\n`;
  const changes = diffApp(
    await describeApp(await compile(two("/api/orders/a", "/api/orders/b"))),
    await describeApp(await compile(two("/api/orders/c", "/api/orders/d"))),
  );
  expect(changes.filter(c => c.id.startsWith("rest:POST /api/orders/") && c.field !== "triggers")).toEqual([
    {
      id: "rest:POST /api/orders/c",
      field: "exposure",
      direction: "changed",
      before: "rest:POST /api/orders/a",
      after: "rest:POST /api/orders/c",
    },
    {
      id: "rest:POST /api/orders/d",
      field: "exposure",
      direction: "changed",
      before: "rest:POST /api/orders/b",
      after: "rest:POST /api/orders/d",
    },
  ]);
});

test("diff: a move that also renames {k} is not a URI-only move", async () => {
  const text = withGet
    .replace('path: "/api/docs/{id}"', 'path: "/api/docs/{doc}"')
    .replace("required: [id], properties: {id: {type: string}}}", "required: [doc], properties: {doc: {type: string}}}")
    .replace(
      "WHERE id = input.id ORDER BY id\n---\n" + H + "kind: View\nmetadata: {name: member-docs}",
      "WHERE id = input.doc ORDER BY id\n---\n" + H + "kind: View\nmetadata: {name: member-docs}",
    );
  const changes = diffApp(await describeApp(await compile(withGet)), await describeApp(await compile(text)));
  expect(lines(changes.filter(c => c.id.startsWith("rest:GET /api/docs/")))).toEqual([
    ["rest:GET /api/docs/:doc", "target", "widened"],
    ["rest:GET /api/docs/:id", "target", "narrowed"],
  ]);
  expect(changes.some(c => c.field === "exposure" && c.before === "rest:GET /api/docs/:id")).toBe(false);
});

test("diff: exposure, behavior and requires lines on formula-2 reports", async () => {
  const plan = await compile(withGet),
    report = await describeApp(plan);
  // Binding change: retyping {id} moves the rest entry's recorded binding.
  const retyped = copy(plan);
  retyped.views["my-doc"].input.properties.id.type = "integer";
  expect(diffApp(report, await describeApp(retyped)).filter(c => c.field === "exposure")).toEqual([
    {
      id: "rest:GET /api/docs/:id",
      field: "exposure",
      direction: "changed",
      before: {
        head: false,
        input: "query",
        path: { id: "string" },
        response: "page",
        strict: true,
      },
      after: {
        head: false,
        input: "query",
        path: { id: "number" },
        response: "page",
        strict: true,
      },
    },
  ]);
  // Projection change: behavior on the View and every route that reaches it, nothing else.
  const projected = copy(plan);
  projection(projected);
  expect(lines(diffApp(report, await describeApp(projected)))).toEqual(behaviorLines([...myDocRoutes, "view:my-doc"]));
  // Loosened requires stays widened; behavior is reported beside it.
  const strict = copy(plan);
  strict.views["my-doc"].requires = { auth: { all: ["ctx.user"] } };
  expect(lines(diffApp(await describeApp(strict), report))).toEqual([
    ["admin:GET /developer/views/:name", "variants", "widened"],
    ["admin:GET /developer/views/:name", "behavior", "changed"],
    ["rest:GET /api/docs/:id", "requires", "widened"],
    ["rest:GET /api/docs/:id", "variants", "widened"],
    ["rest:GET /api/docs/:id", "behavior", "changed"],
    ["rest:GET /api/views/my-doc", "requires", "widened"],
    ["rest:GET /api/views/my-doc", "variants", "widened"],
    ["rest:GET /api/views/my-doc", "behavior", "changed"],
    ["view:my-doc", "requires", "widened"],
    ["view:my-doc", "behavior", "changed"],
  ]);
  // Exposure fallback: a description-only edit moves only the canonical target's exposureHash.
  const described = copy(plan);
  described.views["my-doc"].description = "One document, by id.";
  expect(lines(diffApp(report, await describeApp(described)))).toEqual([["view:my-doc", "exposure", "changed"]]);
});

test("diff: across the formula change, formula 1 is compared on both sides and never suppressed", async () => {
  const plan = await compile(withGet),
    report = await describeApp(plan),
    projected = copy(plan);
  projection(projected);
  const after = await describeApp(projected),
    star = (before: number, after: number) => ({
      id: "*",
      field: "targetHashVersion",
      direction: "changed" as const,
      before,
      after,
    });
  // A SQL change in the upgrade deploy: the `*` line, then behavior for exactly the targets it reached.
  const upgrade = diffApp(asFormulaV1(report), after);
  expect(upgrade[0]).toEqual(star(1, 2));
  expect(lines(upgrade.slice(1))).toEqual(behaviorLines([...myDocRoutes, "view:my-doc"]));
  expect(diffApp(after, asFormulaV1(report))[0]).toEqual(star(2, 1));
  expect(lines(diffApp(after, asFormulaV1(report)).slice(1))).toEqual(lines(upgrade.slice(1)));
  // A formula-2 report without the transition value: every target unverified, none silent.
  const dropped = copy(after);
  for (const t of dropped.targets) delete t._meta.targetHashV1;
  expect(lines(diffApp(asFormulaV1(report), dropped))).toEqual([
    ["*", "targetHashVersion", "changed"],
    ...dropped.targets.map((t: any): Line => [t._meta.id, "behavior", "changed", true]).sort(),
  ]);
  // A SQL change beside another recorded change still gets its behavior line, in both directions.
  const both = copy(projected);
  both.views["my-doc"].requires = { auth: { all: ["ctx.user"] } };
  const strictAndProjected = await describeApp(both);
  const behaviorOf = (c: any[]) =>
    lines(c.filter(x => x.field === "behavior"))
      .map(([id]) => id)
      .sort();
  expect(behaviorOf(diffApp(asFormulaV1(report), strictAndProjected))).toEqual([...myDocRoutes, "view:my-doc"].sort());
  expect(behaviorOf(diffApp(strictAndProjected, asFormulaV1(report)))).toEqual([...myDocRoutes, "view:my-doc"].sort());
  expect(
    diffApp(asFormulaV1(report), strictAndProjected).some(c => c.id === "view:my-doc" && c.field === "requires"),
  ).toBe(true);
});

test("diff: two formula-1 reports read as before formula 2", async () => {
  const plan = await compile(withGet),
    report = asFormulaV1(await describeApp(plan));
  const projected = copy(plan),
    strict = copy(plan);
  projection(projected);
  strict.views["my-doc"].requires = { auth: { all: ["ctx.user"] } };
  expect(diffApp(report, report)).toEqual([]);
  // Behavior only from the pin, and only when nothing else was recorded; no `*`, exposure or unverified line.
  expect(lines(diffApp(report, asFormulaV1(await describeApp(projected))))).toEqual(
    behaviorLines([...myDocRoutes, "view:my-doc"]),
  );
  expect(lines(diffApp(asFormulaV1(await describeApp(strict)), report))).toEqual([
    ["admin:GET /developer/views/:name", "variants", "widened"],
    ["rest:GET /api/docs/:id", "requires", "widened"],
    ["rest:GET /api/docs/:id", "variants", "widened"],
    ["rest:GET /api/views/my-doc", "requires", "widened"],
    ["rest:GET /api/views/my-doc", "variants", "widened"],
    ["view:my-doc", "requires", "widened"],
  ]);
  // Without formula-2 keys a REST path move cannot be verified as URI-only: it stays a removed and an added target.
  const moved = asFormulaV1(await describeApp(await compile(withGet.replace("/api/docs/", "/api/documents/"))));
  expect(lines(diffApp(report, moved).filter(c => c.id.startsWith("rest:GET /api/doc")))).toEqual([
    ["rest:GET /api/docs/:id", "target", "narrowed"],
    ["rest:GET /api/documents/:id", "target", "widened"],
  ]);
});
