import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { parseManifests } from "./parse.js";
import { validateManifests } from "./parse.js";
import type { SchemaManifest } from "../../src/build/spec/domain/model/ManifestGrammar.js";

// Translation references use the same check as the manifest linker.

function schema(name: string, spec: Partial<SchemaManifest["spec"]>): SchemaManifest {
  return {
    apiVersion: "cms.mantle.aotter.net/v2",
    kind: "Schema",
    metadata: { name },
    spec: {
      title: name,
      schema: {
        type: "object",
        properties: { slug: { type: "string" }, title: { type: "string" }, ...(spec.localized ? { locale: { type: "string" } } : {}) },
      },
      ...spec,
    } as SchemaManifest["spec"],
  };
}

describe("checkTranslatesReferences — TRANSLATES_PARENT_UNKNOWN", () => {

  it("includes candidates in the diagnostic for did-you-mean suggestions", () => {
    const parent = schema("posts", {});
    const child = schema("post-translations", {
      localized: true,
      translates: { parent: "post", on: "slug" }, // typo: missing 's'
    });
    const diags = validateManifests({ manifests: [parent, child] }).diagnostics;
    const d = diags.find((x) => x.code === "TRANSLATES_PARENT_UNKNOWN");
    expect(d?.candidates).toContain("posts");
    expect(d?.suggestion).toBe("posts");
  });
});

describe("checkTranslatesReferences — TRANSLATES_PARENT_IS_LOCALIZED", () => {
  it("rejects translates.parent that is itself localized", () => {
    const parent = schema("posts", { localized: true });
    const child = schema("post-translations", {
      localized: true,
      translates: { parent: "posts", on: "slug" },
    });
    const diags = validateManifests({ manifests: [parent, child] }).diagnostics;
    expect(diags.map((d) => d.code)).toContain("TRANSLATES_PARENT_IS_LOCALIZED");
  });
});

describe("checkTranslatesReferences — TRANSLATES_FIELD_NOT_IN_PARENT", () => {
  it("flags join field missing from parent Schema properties", () => {
    const parent: SchemaManifest = {
      apiVersion: "cms.mantle.aotter.net/v2",
      kind: "Schema",
      metadata: { name: "products" },
      spec: {
        title: "Products",
        schema: { type: "object", properties: { sku: { type: "string" } } },
      },
    };
    const child = schema("product-translations", {
      localized: true,
      translates: { parent: "products", on: "slug" }, // parent has no slug
    });
    const diags = validateManifests({ manifests: [parent, child] }).diagnostics;
    expect(diags.map((d) => d.code)).toContain("TRANSLATES_FIELD_NOT_IN_PARENT");
  });

});

describe("checkTranslatesReferences — happy path (parent + child correctly wired)", () => {

  it("parses and validates the shipped parent/translation golden manifest", () => {
    const yaml = readFileSync(
      new URL("./fixtures/i18n-parent-child/manifests/site.yaml", import.meta.url),
      "utf8",
    );
    const parsed = parseManifests(yaml);
    expect(parsed.diagnostics).toEqual([]);
    expect(validateManifests({
      manifests: parsed.manifests,
    }).diagnostics).toEqual([]);
  });
});
