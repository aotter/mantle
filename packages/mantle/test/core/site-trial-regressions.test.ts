// Regressions from running a real purchase-request site on the 0.2.x tip: each test names the gap it pins.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LocalD1 } from "../../src/cloudflare/testing/d1.js";
import { compilePlan } from "../../src/spec/index.js";
import { createMantleRuntime, type Caller, type InvocationCause, type MantleRuntime } from "../../src/core/index.js";
import { sqliteStorage } from "../../src/d1/index.js";
import { createAdminSurface } from "../../src/admin/index.js";

const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/;
const MANIFESTS = `apiVersion: cms.mantle.aotter.net/v2
kind: Schema
metadata: { name: requests }
spec:
  title: Requests
  lifecycle: operational
  uniqueIndexes: [[requestNumber]]
  indexes: [[requestStatus]]
  uiSchema: { list: { primaryField: requestNumber, filterField: requestStatus } }
  schema:
    type: object
    required: [requestNumber, totalMinor, requestStatus]
    properties:
      requestNumber: { type: string }
      totalMinor: { type: integer, x-mcp-hint: money-minor }
      requestStatus:
        type: string
        oneOf: [{ const: submitted, title: { en: Submitted, zh-TW: 已送出 } }, { const: approved, title: { en: Approved, zh-TW: 已核准 } }]
---
apiVersion: cms.mantle.aotter.net/v2
kind: Schema
metadata: { name: request-lines }
spec:
  title: Lines
  lifecycle: operational
  indexes: [[requestNumber]]
  schema:
    type: object
    required: [requestNumber, item]
    properties:
      requestNumber: { type: string, x-mantle-ref: { schema: requests, field: requestNumber } }
      item: { type: string }
---
apiVersion: cms.mantle.aotter.net/v2
kind: Schema
metadata: { name: line-notes }
spec:
  title: Notes
  lifecycle: operational
  uiSchema: { nav: { standalone: true } }
  schema:
    type: object
    required: [requestNumber, lineId]
    properties:
      requestNumber: { type: string, x-mantle-ref: { schema: requests, field: requestNumber } }
      lineId: { type: string, x-mantle-ref: request-lines }
---
apiVersion: cms.mantle.aotter.net/v2
kind: Procedure
metadata: { name: approve }
spec:
  input: { type: object, required: [id], properties: { id: { type: string } } }
  output: { type: object }
  handler: { sql: "UPDATE requests SET requestStatus = 'approved' WHERE id = input.id RETURNING id, requestStatus AS \\"requestStatus\\"" }
---
apiVersion: cms.mantle.aotter.net/v2
kind: Procedure
metadata: { name: audit }
spec: { input: { type: object }, output: { type: object }, handler: { ref: audit } }
---
apiVersion: cms.mantle.aotter.net/v2
kind: Trigger
metadata: { name: audit-update }
spec: { source: { kind: lifecycle, schema: requests, on: [after_update] }, target: { procedure: audit } }
---
apiVersion: cms.mantle.aotter.net/v2
kind: View
metadata: { name: totals }
spec:
  title: Totals
  surface: staff
  uiSchema: { list: { columns: [requestStatus, n, totalMinor, newest] } }
  sql: SELECT requestStatus, count(*) AS n, sum(totalMinor) AS totalMinor, max(created_at) AS newest FROM requests GROUP BY requestStatus ORDER BY requestStatus
---
apiVersion: cms.mantle.aotter.net/v2
kind: View
metadata: { name: recent }
spec: { surface: public, sql: "SELECT requestNumber, created_at FROM requests ORDER BY created_at DESC" }
`;

const owner: Caller = { kind: "user", subject: "o1", role: "owner", scopes: [], credential: "session", credentialId: null, clientId: null };
let rt: MantleRuntime;
let d1: LocalD1;
const causes: InvocationCause[] = [];
let ids: string[] = [];
beforeAll(async () => {
  const res = await compilePlan({ sources: [{ sourceId: "memory:trial", text: MANIFESTS }] });
  if (!res.ok) throw new Error(JSON.stringify(res.diagnostics));
  d1 = await LocalD1.create();
  rt = await createMantleRuntime({ plan: res.plan, storage: sqliteStorage(d1), handlers: { audit: (_i, ctx) => (causes.push(ctx.cause), {}) } });
  ids = (await rt.store.write([
    { insert: "requests", values: { requestNumber: "PR-1", totalMinor: 1500, requestStatus: "submitted" } },
    { insert: "requests", values: { requestNumber: "PR-2", totalMinor: 2500, requestStatus: "submitted" } },
    { insert: "request-lines", values: { requestNumber: "PR-1", item: "laptop" } },
  ])).slice(0, 2).map((r) => (r as { id: string }).id);
});
afterAll(() => d1?.dispose());

describe("after hooks", () => {
  it("get the whole row in Store's shape whatever the statement returns, and the result keeps only what it asked for", async () => {
    const out = await rt.invokeProcedure({ procedure: "approve", input: { id: ids[0] }, caller: owner, cause: { kind: "http", id: "a1" } });
    expect(out).toEqual({ results: [[{ id: ids[0], requestStatus: "approved" }]] });
    const [row] = (causes.at(-1) as { rows: Record<string, unknown>[] }).rows;
    expect(row).toMatchObject({ id: ids[0], version: 2, requestNumber: "PR-1", totalMinor: 1500, requestStatus: "approved", authorId: null });
    expect(row!.createdAt).toMatch(ISO);
    expect(row).not.toHaveProperty("created_at");
  });

  it("get the same shape from a Store write", async () => {
    await rt.store.write([{ update: "requests", set: { totalMinor: 2600 }, where: { id: ids[1]! } }]);
    const [row] = (causes.at(-1) as { rows: Record<string, unknown>[] }).rows;
    expect(row).toMatchObject({ id: ids[1], requestNumber: "PR-2", totalMinor: 2600 });
    expect(row!.updatedAt).toMatch(ISO);
  });
});

describe("the wire", () => {
  it("returns the entry's timestamps as ISO date-times from Store and from a View", async () => {
    const [r] = (await rt.store.db.requests.find({ columns: ["createdAt", "updatedAt"], limit: 1 })).rows;
    expect(r!.createdAt).toMatch(ISO);
    expect(r!.updatedAt).toMatch(ISO);
    expect((await rt.store.view("recent")).rows[0]!.created_at).toMatch(ISO);
  });

  it("keeps a sum's and a max's type: money stays money, a max of created_at is a date-time, a count is a number", async () => {
    expect(rt.plan.views["totals"]!.columns).toMatchObject({ totalminor: { schema: "requests", field: "totalminor" }, newest: { schema: "requests", field: "created_at" } });
    expect(rt.plan.views["totals"]!.columns).not.toHaveProperty("n");
    const rows = (await rt.store.view("totals")).rows;
    expect(rows.map((r) => [r.requestStatus, r.n, r.totalMinor])).toEqual([["approved", 1, 1500], ["submitted", 1, 2600]]);
    expect(rows[0]!.newest).toMatch(ISO);
  });

  it("stores a oneOf of string consts as text and filters on it", async () => {
    expect(rt.plan.schemas["requests"]!.fields["requeststatus"]).toBe("text");
    await expect(rt.store.write([{ insert: "requests", values: { requestNumber: "PR-9", totalMinor: 1, requestStatus: "nope" } }])).rejects.toThrow();
  });
});

describe("Admin", () => {
  const admin = (path: string) => createAdminSurface(rt, { basePath: "/admin" })(new Request(`http://x/admin/api${path}`), owner);

  it("relates lines to their request by a unique-field reference, both ways", async () => {
    const entry = await (await admin(`/entries/${ids[0]}?collection=requests`)).json();
    expect(entry.related.map((r: { relationship: { parentField: string; childField: string }; entries: unknown[] }) => [r.relationship.parentField, r.relationship.childField, r.entries.length])).toEqual([["requestNumber", "requestNumber", 1], ["requestNumber", "requestNumber", 0]]);
    const collections = (await (await admin("/collections")).json()).collections;
    expect(collections.find((c: { name: string }) => c.name === "request-lines").parent).toEqual({ collection: "requests", parentField: "requestNumber", childField: "requestNumber" });
    expect(collections.find((c: { name: string }) => c.name === "requests").filter).toEqual({ field: "requestStatus", values: ["submitted", "approved"] });
    // an id reference is the parent even when a unique-field reference is declared first; a standalone list scopes by id only
    const notes = collections.find((c: { name: string }) => c.name === "line-notes");
    expect(notes.parent).toEqual({ collection: "request-lines", parentField: "id", childField: "lineId" });
    expect(notes.nav).toEqual({ standalone: true, parentField: "lineId", parentCollection: "request-lines" });
  });
});

describe("Admin capabilities", () => {
  it("says which optional pages this deployment turned on, so the console offers none that can only answer 501", async () => {
    const site = await (await createAdminSurface(rt, { basePath: "/admin" })(new Request("http://x/admin/api/site"), owner)).json();
    expect(site.capabilities).toEqual({ siteSettings: false, media: false, invitationEmail: false, statistics: false });
  });
});

describe("compile", () => {
  const view = (columns: string, sql: string) => `apiVersion: cms.mantle.aotter.net/v2
kind: Schema
metadata: { name: t }
spec: { title: T, lifecycle: operational, schema: { type: object, properties: { totalMinor: { type: integer } } } }
---
apiVersion: cms.mantle.aotter.net/v2
kind: View
metadata: { name: v }
spec: { title: V, surface: staff, uiSchema: { list: { columns: [${columns}] } }, sql: '${sql}' }
`;
  const codes = async (text: string) => { const r = await compilePlan({ sources: [{ sourceId: "m", text }] }); return r.ok ? [] : r.diagnostics.map((d) => [d.code, d.message]); };

  it("refuses a column whose name matches an output only by case, and says to quote the alias", async () => {
    const [[code, message]] = await codes(view("Total", 'SELECT count(*) AS Total FROM t ORDER BY 1')) as [string, string][];
    expect(code).toBe("VIEW_UI_INVALID");
    expect(message).toContain(`the row carries 'total': an unquoted alias folds to lower case, so write AS "Total"`);
    expect(await codes(view("Total", 'SELECT count(*) AS "Total" FROM t ORDER BY 1'))).toEqual([]);
    // a field read is renamed to its declared spelling, so the camelCase name matches
    expect(await codes(view("totalMinor", "SELECT totalMinor FROM t ORDER BY 1"))).toEqual([]);
  });
});
