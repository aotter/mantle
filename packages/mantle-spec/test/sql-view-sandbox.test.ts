import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  parseManifestSources,
  ValidateManifestsUseCase,
} from "../src/index.js";

const schema = `apiVersion: cms.mantle.aotter.net/v1
kind: Schema
metadata: { name: posts }
spec:
  title: Posts
  lifecycle: publishing
  schema:
    type: object
    properties:
      slug: { type: string }
`;

function validate(sql: string) {
  const parsed = parseManifestSources({ sources: [{
    sourceId: "test.yaml",
    text: `${schema}\n---\napiVersion: cms.mantle.aotter.net/v1
kind: View
metadata: { name: test-view }
spec:
  surface: public
  sql: ${sql}
`,
  }] });
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.diagnostics));
  const db = new DatabaseSync(":memory:");
  try {
    return ValidateManifestsUseCase.run({
      parsed: parsed.value,
      sqlViewSandbox: {
        exec: (statement) => db.exec(statement),
      },
    });
  } finally {
    db.close();
  }
}

describe("SQL View sandbox", () => {
  it("accepts declared Schema tables", () => {
    expect(validate("SELECT slug FROM posts WHERE _mantle_status = 'published'").errorCount)
      .toBe(0);
  });

  it.each([
    "SELECT 'sqlite_backup' AS label",
    "SELECT sqlite_version() AS version",
    `SELECT 1 AS "from", 'sqlite_backup' AS "pragma_table_list"`,
  ])("does not mistake SQLite text or scalar functions for a table in %s", (sql) => {
    expect(validate(sql).errorCount).toBe(0);
  });

  it.each([
    "SELECT * FROM user",
    "SELECT * FROM sqlite_schema",
    `SELECT * FROM "sqlite_schema"`,
    "SELECT * FROM main.sqlite_schema",
    "SELECT * FROM dbstat",
    "SELECT * FROM pragma_table_list",
    "SELECT * FROM pragma_table_info('session')",
    "SELECT * FROM posts, pragma_table_info('session')",
    "SELECT (SELECT 1 FROM oauthAccessToken LIMIT 1) FROM posts",
    "SELECT p.slug FROM posts p JOIN account a ON a.id = p.slug",
    "SELECT * FROM (WITH x AS (SELECT * FROM session) SELECT * FROM x)",
  ])("rejects undeclared tables in %s", (sql) => {
    const result = validate(sql);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: "INVALID_MANIFEST_ENVELOPE",
        path: "/spec/sql",
        message: expect.stringMatching(/no such table|internal tables/u),
      }),
    ]);
  });

  it("does not construct a SQLite sandbox when there are no SQL Views", () => {
    const parsed = parseManifestSources({ sources: [{
      sourceId: "portable.yaml",
      text: `apiVersion: cms.mantle.aotter.net/v1
kind: Schema
metadata: { name: portable }
spec:
  title: Portable
  schema:
    type: object
    properties:
      Title: { type: string }
      title: { type: string }
`,
    }] });
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.diagnostics));
    expect(ValidateManifestsUseCase.run({
      parsed: parsed.value,
      sqlViewSandbox: { exec: () => { throw new Error("sandbox should not run"); } },
    }).errorCount).toBe(0);
  });
});
