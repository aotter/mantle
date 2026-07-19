import { describe, expect, it } from "vitest";
import { buildDdl } from "../src/domain/service/SchemaDdlEmitter.js";
import type { SchemaManifest } from "../src/domain/model/ManifestGrammar.js";

const baseManifest = (name: string): SchemaManifest => ({
  apiVersion: "cms.mantle.aotter.net/v1",
  kind: "Schema",
  metadata: { name },
  spec: {
    schema: {
      type: "object",
      properties: { slug: { type: "string" } },
    },
    uniqueIndexes: [["slug"]],
  },
});

describe("buildDdl", () => {
  it("emits ALTER + CREATE INDEX for a well-formed schema", () => {
    const ddl = buildDdl(baseManifest("posts"));
    expect(ddl.addColumns).toHaveLength(1);
    expect(ddl.addColumns[0]).toMatch(/posts__slug/);
    expect(ddl.createIndexes[0]).toMatch(/uq_posts__slug/);
  });

  it("rejects an unsafe collection name (SQL injection guard)", () => {
    expect(() => buildDdl(baseManifest("foo'; DROP TABLE entries; --"))).toThrow(
      /unsafe collection identifier/,
    );
  });

  it("quotes legal kebab-case identifiers", () => {
    const ddl = buildDdl(baseManifest("contact-messages"));
    expect(ddl.addColumns[0]).toContain('"contact-messages__slug"');
    expect(ddl.createIndexes[0]).toContain('"uq_contact-messages__slug"');
  });

  it("composite unique index guards every column as NOT NULL (not just the first)", () => {
    // Regression: prior `WHERE cols[0] IS NOT NULL` let rows with
    // mixed-NULL composites silently collide as (col0, NULL).
    const manifest: SchemaManifest = {
      apiVersion: "cms.mantle.aotter.net/v1",
      kind: "Schema",
      metadata: { name: "translations" },
      spec: {
        schema: {
          type: "object",
          properties: { locale: { type: "string" }, slug: { type: "string" } },
        },
        uniqueIndexes: [["locale", "slug"]],
      },
    };
    const ddl = buildDdl(manifest);
    expect(ddl.createIndexes[0]).toMatch(
      /WHERE "translations__locale" IS NOT NULL AND "translations__slug" IS NOT NULL/,
    );
  });
});
