// ADR-0046 spike: the app-level auth block, auth.attr() in SQL and Schema scope, as Core compiles them.
import { describe, expect, it } from "vitest";
import { compilePlan, parseManifestSources } from "../../src/spec/index.js";
import { lowerPlan } from "../../src/core/sql/lowered.js";
import * as pgCompile from "../../src/postgres/compile/index.js";
import * as d1Compile from "../../src/d1/compile/index.js";
import { d1Dialect } from "../../src/d1/dialect.js";
import { postgresDialect } from "../../src/postgres/dialect.js";

const AUTH = `auth:
  roles: [sales]
  attributes:
    region: { type: string, multiple: true }
    tier: { type: string }
---
`;
const ORDERS = `apiVersion: cms.mantle.aotter.net/v2
kind: Schema
metadata: { name: orders }
spec:
  title: Orders
  lifecycle: operational
  indexes: [[region]]
  schema: { type: object, required: [region, tier], properties: { region: { type: string }, tier: { type: string } } }
---
apiVersion: cms.mantle.aotter.net/v2
kind: View
metadata: { name: mine }
spec: { surface: internal, sql: "SELECT id, region FROM orders WHERE region IN (auth.attr('region')) AND tier = auth.attr('tier') ORDER BY id" }
`;
const compile = (text: string, dialect = d1Compile) => compilePlan({ sources: [{ sourceId: "a.yaml", text }] }, dialect, "operational");

describe("auth block", () => {
  it("parses roles and attributes into the plan, and a plan without a block has none", async () => {
    const withBlock = await compile(AUTH + ORDERS);
    expect(withBlock.ok && withBlock.plan.auth).toEqual({ roles: ["sales"], attributes: { region: { type: "string", multiple: true }, tier: { type: "string", multiple: false } } });
    const without = await compile(ORDERS.replace(/ AND tier = auth.attr\('tier'\)/, "").replace("region IN (auth.attr('region'))", "region = 'x'"));
    expect(without.ok && "auth" in without.plan).toBe(false);
  });
  it("refuses an undeclared attribute, a repeated block and a bad block", async () => {
    expect((await compile(ORDERS)).ok).toBe(false);
    const dup = parseManifestSources({ sources: [{ sourceId: "a.yaml", text: AUTH + AUTH + ORDERS }] });
    expect(dup.ok).toBe(false);
    expect(parseManifestSources({ sources: [{ sourceId: "a.yaml", text: "auth:\n  roles: [staff]\n" }] }).ok).toBe(false);
  });
  it("lowers one bind per attribute: SQLite json_each, PostgreSQL = ANY on a text-typed parameter", async () => {
    const sqlite = await compile(AUTH + ORDERS), pg = await compile(AUTH + ORDERS, pgCompile);
    if (!sqlite.ok || !pg.ok) throw new Error("compile");
    const s = lowerPlan(sqlite.plan, d1Dialect).lowered.views.mine!.caller!, p = lowerPlan(pg.plan, postgresDialect()).lowered.views.mine!.caller!;
    expect(s.sql).toContain("json_each(");
    expect(s.binds.map((b) => b.k)).toEqual(["attr", "attr"]);
    expect(p.sql).toContain("= ANY(CAST(CAST(($1) AS text) AS text[]))");
    expect(p.binds[0]).toEqual({ k: "attr", name: "region", multiple: true, type: "string" });
  });
});
