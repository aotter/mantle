import { describe, expect, it } from "vitest";
import { resolveLocalizedText } from "../src/domain/model/ManifestGrammar.js";
import { parseManifests } from "../src/domain/service/ManifestParser.js";
import type {
  ProcedureManifest,
  SchemaManifest,
} from "../src/domain/model/ManifestGrammar.js";

/**
 * #430 — `LocalizedText` grammar (`Schema.spec.title`/`.description`,
 * `Procedure.spec.title`/`.description`): the resolver in
 * `ManifestGrammar.ts` and the shape validation the parser applies to
 * both atoms.
 */

const apiVersion = "cms.mantle.aotter.net/v1" as const;

describe("resolveLocalizedText", () => {
  it("returns a plain string as-is", () => {
    expect(resolveLocalizedText("Products", "zh-TW")).toBe("Products");
  });

  it("returns the preferred locale's exact-key value when present", () => {
    const value = { en: "Products", "zh-TW": "商品" };
    expect(resolveLocalizedText(value, "zh-TW")).toBe("商品");
  });

  it("falls back to the canonical locale when preferred is absent", () => {
    const value = { en: "Products", "zh-TW": "商品" };
    expect(resolveLocalizedText(value, "ja", "en")).toBe("Products");
  });

  it("falls back to the first entry when neither preferred nor canonical match", () => {
    const value = { fr: "Produits", de: "Produkte" };
    expect(resolveLocalizedText(value, "ja", "en")).toBe("Produits");
  });

  it("resolves null/undefined to null", () => {
    expect(resolveLocalizedText(null, "en")).toBeNull();
    expect(resolveLocalizedText(undefined, "en")).toBeNull();
  });

  it("prefers the exact preferred key over canonical even when canonical is also present", () => {
    const value = { en: "Products", "zh-TW": "商品", ja: "製品" };
    expect(resolveLocalizedText(value, "ja", "en")).toBe("製品");
  });
});

function schemaDoc(spec: Record<string, unknown>): string {
  return `apiVersion: ${apiVersion}\nkind: Schema\nmetadata:\n  name: posts\nspec:\n${indent(spec)}`;
}

function procedureDoc(spec: Record<string, unknown>): string {
  return `apiVersion: ${apiVersion}\nkind: Procedure\nmetadata:\n  name: doThing\nspec:\n${indent(spec)}`;
}

// Minimal YAML emitter for the flat shapes these tests need — avoids
// pulling in a YAML stringify dependency for a handful of fixtures.
function indent(obj: Record<string, unknown>): string {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(obj)) {
    if (value === undefined) continue;
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      lines.push(`  ${key}:`);
      for (const [subKey, subValue] of Object.entries(value)) {
        lines.push(`    ${subKey}: ${JSON.stringify(subValue)}`);
      }
    } else {
      lines.push(`  ${key}: ${JSON.stringify(value)}`);
    }
  }
  return lines.join("\n");
}

describe("ManifestParser — Schema.spec.title / .description (LocalizedText)", () => {
  it("accepts a plain non-empty string title", () => {
    const yaml = schemaDoc({
      title: "Posts",
      schema: { type: "object" },
    });
    const { manifests, diagnostics } = parseManifests(yaml);
    expect(diagnostics).toEqual([]);
    expect((manifests[0] as SchemaManifest).spec.title).toBe("Posts");
  });

  it("accepts a locale-map object title with non-empty string values", () => {
    const yaml = schemaDoc({
      title: { en: "Posts", "zh-TW": "文章" },
      schema: { type: "object" },
    });
    const { manifests, diagnostics } = parseManifests(yaml);
    expect(diagnostics).toEqual([]);
    expect((manifests[0] as SchemaManifest).spec.title).toEqual({
      en: "Posts",
      "zh-TW": "文章",
    });
  });

  it("rejects a missing title", () => {
    const yaml = schemaDoc({ schema: { type: "object" } });
    const { manifests, diagnostics } = parseManifests(yaml);
    expect(manifests).toEqual([]);
    expect(diagnostics[0]?.path).toContain("/spec/title");
  });

  it("rejects an empty string title", () => {
    const yaml = schemaDoc({ title: "", schema: { type: "object" } });
    const { diagnostics } = parseManifests(yaml);
    expect(diagnostics[0]?.path).toContain("/spec/title");
  });

  it("rejects an empty object title", () => {
    const yaml = schemaDoc({ title: {}, schema: { type: "object" } });
    const { diagnostics } = parseManifests(yaml);
    expect(diagnostics.length).toBeGreaterThan(0);
    expect(diagnostics[0]?.path).toContain("/spec/title");
  });

  it("rejects a title object with a non-string value", () => {
    const yaml = schemaDoc({
      title: { en: "Posts", "zh-TW": 42 },
      schema: { type: "object" },
    });
    const { diagnostics } = parseManifests(yaml);
    expect(diagnostics.length).toBeGreaterThan(0);
    expect(diagnostics[0]?.path).toContain("/spec/title");
  });

  it("rejects a title array (arrays are not a valid LocalizedText shape)", () => {
    const yaml = schemaDoc({ title: ["Posts"], schema: { type: "object" } });
    const { diagnostics } = parseManifests(yaml);
    expect(diagnostics.length).toBeGreaterThan(0);
  });

  it("description is optional — absent is fine", () => {
    const yaml = schemaDoc({ title: "Posts", schema: { type: "object" } });
    const { manifests, diagnostics } = parseManifests(yaml);
    expect(diagnostics).toEqual([]);
    expect((manifests[0] as SchemaManifest).spec.description).toBeUndefined();
  });

  it("accepts a locale-map description", () => {
    const yaml = schemaDoc({
      title: "Posts",
      description: { en: "Blog posts.", "zh-TW": "部落格文章。" },
      schema: { type: "object" },
    });
    const { manifests, diagnostics } = parseManifests(yaml);
    expect(diagnostics).toEqual([]);
    expect((manifests[0] as SchemaManifest).spec.description).toEqual({
      en: "Blog posts.",
      "zh-TW": "部落格文章。",
    });
  });

  it("rejects an empty-string description when present", () => {
    const yaml = schemaDoc({
      title: "Posts",
      description: "",
      schema: { type: "object" },
    });
    const { diagnostics } = parseManifests(yaml);
    expect(diagnostics.length).toBeGreaterThan(0);
    expect(diagnostics[0]?.path).toContain("/spec/description");
  });
});

describe("ManifestParser — Procedure.spec.title / .description (LocalizedText, optional)", () => {
  it("accepts a Procedure with neither title nor description", () => {
    const yaml = procedureDoc({
      input: { type: "object" },
      output: { type: "object" },
      handler: { kind: "ref", ref: "doThing" },
    });
    const { manifests, diagnostics } = parseManifests(yaml);
    expect(diagnostics).toEqual([]);
    const proc = manifests[0] as ProcedureManifest;
    expect(proc.spec.title).toBeUndefined();
    expect(proc.spec.description).toBeUndefined();
  });

  it("accepts a plain string title and description", () => {
    const yaml = procedureDoc({
      title: "Do Thing",
      description: "Does the thing.",
      input: { type: "object" },
      output: { type: "object" },
      handler: { kind: "ref", ref: "doThing" },
    });
    const { manifests, diagnostics } = parseManifests(yaml);
    expect(diagnostics).toEqual([]);
    const proc = manifests[0] as ProcedureManifest;
    expect(proc.spec.title).toBe("Do Thing");
    expect(proc.spec.description).toBe("Does the thing.");
  });

  it("accepts a locale-map title and description", () => {
    const yaml = procedureDoc({
      title: { en: "Do Thing", "zh-TW": "執行操作" },
      description: { en: "Does the thing.", "zh-TW": "執行這個操作。" },
      input: { type: "object" },
      output: { type: "object" },
      handler: { kind: "ref", ref: "doThing" },
    });
    const { manifests, diagnostics } = parseManifests(yaml);
    expect(diagnostics).toEqual([]);
    const proc = manifests[0] as ProcedureManifest;
    expect(proc.spec.title).toEqual({ en: "Do Thing", "zh-TW": "執行操作" });
  });

  it("rejects an empty object title when present", () => {
    const yaml = procedureDoc({
      title: {},
      input: { type: "object" },
      output: { type: "object" },
      handler: { kind: "ref", ref: "doThing" },
    });
    const { diagnostics } = parseManifests(yaml);
    expect(diagnostics.length).toBeGreaterThan(0);
    expect(diagnostics[0]?.path).toContain("/spec/title");
  });

  it("rejects a non-string, non-object title", () => {
    const yaml = procedureDoc({
      title: 42,
      input: { type: "object" },
      output: { type: "object" },
      handler: { kind: "ref", ref: "doThing" },
    });
    const { diagnostics } = parseManifests(yaml);
    expect(diagnostics.length).toBeGreaterThan(0);
    expect(diagnostics[0]?.path).toContain("/spec/title");
  });

  it("rejects an empty-string description with a message naming the field", () => {
    const yaml = procedureDoc({
      description: "",
      input: { type: "object" },
      output: { type: "object" },
      handler: { kind: "ref", ref: "doThing" },
    });
    const { diagnostics } = parseManifests(yaml);
    expect(diagnostics.length).toBeGreaterThan(0);
    expect(diagnostics[0]?.path).toContain("/spec/description");
    expect(diagnostics[0]?.message).toContain("Procedure.spec.description");
  });
});
