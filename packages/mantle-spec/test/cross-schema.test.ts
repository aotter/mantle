import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { checkLocaleAndTranslates } from "../src/domain/service/CrossSchemaChecker.js";
import { parseManifests } from "./parse.js";
import { validateManifests } from "./parse.js";
import type { SchemaManifest } from "../src/domain/model/ManifestGrammar.js";

// Cross-Schema validation from ADR-0010. Runs in the validate phase
// (CLI, optional siteLocales) and the boot phase (Worker, always with
// siteLocales from D1). Every locale/translation diagnostic is exercised here.

function schema(name: string, spec: Partial<SchemaManifest["spec"]>): SchemaManifest {
  return {
    apiVersion: "cms.mantle.aotter.net/v1",
    kind: "Schema",
    metadata: { name },
    spec: {
      title: name,
      schema: {
        type: "object",
        properties: { slug: { type: "string" }, title: { type: "string" } },
      },
      ...spec,
    } as SchemaManifest["spec"],
  };
}

describe("checkLocaleAndTranslates — SCHEMA_LOCALIZED_REQUIRES_SITE_LOCALES", () => {
  const localized = schema("posts", { localized: true });

  it("rejects localized Schema when site has empty locales", () => {
    const diags = checkLocaleAndTranslates({
      schemas: [localized],
      phase: "boot",
      siteLocales: [],
    });
    const codes = diags.map((d) => d.code);
    expect(codes).toContain("SCHEMA_LOCALIZED_REQUIRES_SITE_LOCALES");
    expect(diags[0]?.path).toMatch(/posts/);
  });

  it("passes when site has at least one locale", () => {
    const diags = checkLocaleAndTranslates({
      schemas: [localized],
      phase: "boot",
      siteLocales: ["en"],
    });
    expect(diags.filter((d) => d.code === "SCHEMA_LOCALIZED_REQUIRES_SITE_LOCALES")).toHaveLength(0);
  });

  it("skips the check entirely when siteLocales is undefined (validate-from-CLI path)", () => {
    const diags = checkLocaleAndTranslates({
      schemas: [localized],
      phase: "validate",
    });
    expect(diags.filter((d) => d.code === "SCHEMA_LOCALIZED_REQUIRES_SITE_LOCALES")).toHaveLength(0);
  });
});

describe("checkLocaleAndTranslates — TRANSLATES_PARENT_UNKNOWN", () => {
  it("flags a translates.parent that doesn't resolve to any declared Schema", () => {
    const child = schema("post-translations", {
      localized: true,
      translates: { parent: "ghost", on: "slug" },
    });
    const diags = checkLocaleAndTranslates({ schemas: [child], phase: "validate" });
    const codes = diags.map((d) => d.code);
    expect(codes).toContain("TRANSLATES_PARENT_UNKNOWN");
  });

  it("includes candidates in the diagnostic for did-you-mean suggestions", () => {
    const parent = schema("posts", {});
    const child = schema("post-translations", {
      localized: true,
      translates: { parent: "post", on: "slug" }, // typo: missing 's'
    });
    const diags = checkLocaleAndTranslates({ schemas: [parent, child], phase: "validate" });
    const d = diags.find((x) => x.code === "TRANSLATES_PARENT_UNKNOWN");
    expect(d?.candidates).toContain("posts");
    expect(d?.suggestion).toBe("posts");
  });
});

describe("checkLocaleAndTranslates — TRANSLATES_PARENT_IS_LOCALIZED", () => {
  it("rejects translates.parent that is itself localized", () => {
    const parent = schema("posts", { localized: true });
    const child = schema("post-translations", {
      localized: true,
      translates: { parent: "posts", on: "slug" },
    });
    const diags = checkLocaleAndTranslates({ schemas: [parent, child], phase: "validate" });
    expect(diags.map((d) => d.code)).toContain("TRANSLATES_PARENT_IS_LOCALIZED");
  });
});

describe("checkLocaleAndTranslates — TRANSLATES_FIELD_NOT_IN_PARENT", () => {
  it("flags join field missing from parent Schema properties", () => {
    const parent: SchemaManifest = {
      apiVersion: "cms.mantle.aotter.net/v1",
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
    const diags = checkLocaleAndTranslates({ schemas: [parent, child], phase: "validate" });
    expect(diags.map((d) => d.code)).toContain("TRANSLATES_FIELD_NOT_IN_PARENT");
  });

});

describe("checkLocaleAndTranslates — happy path (parent + child correctly wired)", () => {
  it("emits no diagnostics", () => {
    const parent = schema("products", {});
    const child = schema("product-translations", {
      localized: true,
      translates: { parent: "products", on: "slug" },
    });
    const diags = checkLocaleAndTranslates({
      schemas: [parent, child],
      phase: "boot",
      siteLocales: ["en", "zh-TW"],
    });
    expect(diags).toEqual([]);
  });

  it("parses and validates the shipped parent/translation golden manifest", () => {
    const yaml = readFileSync(
      new URL("./fixtures/i18n-parent-child/manifests/site.yaml", import.meta.url),
      "utf8",
    );
    const parsed = parseManifests(yaml);
    expect(parsed.diagnostics).toEqual([]);
    expect(validateManifests({
      manifests: parsed.manifests,
      siteLocales: ["en", "zh-TW"],
    }).diagnostics).toEqual([]);
  });
});

describe("phase tagging", () => {
  it("tags diagnostics with the requested phase", () => {
    const child = schema("post-translations", {
      localized: true,
      translates: { parent: "ghost", on: "slug" },
    });
    const validateDiags = checkLocaleAndTranslates({ schemas: [child], phase: "validate" });
    const bootDiags = checkLocaleAndTranslates({ schemas: [child], phase: "boot" });
    expect(validateDiags[0]?.phase).toBe("validate");
    expect(bootDiags[0]?.phase).toBe("boot");
  });
});
