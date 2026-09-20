import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { stringify } from "yaml";
import {
  parseManifestSources,
  ValidateManifestsUseCase,
  EntryDataValidator,
} from "../src/index.js";

const fixture = readFileSync(new URL("./fixtures/spec-only-host.yaml", import.meta.url), "utf8");
const siteLocales = ["zh-TW", "en-US"];

function parse(text = fixture) {
  const result = parseManifestSources({ sources: [{ sourceId: "fixture:spec-only-host.yaml", text }] });
  if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
  return result.value;
}

function articleSchema() {
  const entry = parse().entries.find(({ manifest }) => manifest.metadata.name === "articles");
  if (entry?.manifest.kind !== "Schema") throw new Error("Missing articles Schema");
  return entry.manifest;
}

describe("Spec-only host adoption through public exports", () => {
  it("parses and links a read-only inventory with host-owned logical joins", () => {
    const parsed = parse();
    const result = ValidateManifestsUseCase.run({ parsed, siteLocales });
    expect(result.diagnostics).toEqual([]);
    expect(result.errorCount).toBe(0);
    expect(result.linked?.schemas.map(({ manifest }) => manifest.metadata.name))
      .toEqual(["categories", "articles", "article-translations"]);
    expect(result.linked?.schemas.find(({ manifest }) => manifest.metadata.name === "article-translations")
      ?.translationParent?.manifest.metadata.name).toBe("articles");
    expect(parsed.entries.every(({ manifest }) => manifest.kind === "Schema" && manifest.spec.schema.readOnly)).toBe(true);
    expect(articleSchema().spec.schema["x-example-relations"]).toEqual([
      { fromField: "category", to: "categories", toField: "slug", enforced: false },
    ]);
    expect(JSON.stringify(parsed.entries)).not.toContain("x-mantle-ref");
  });

  it("round-trips YAML without losing host annotations or translation declarations", () => {
    const manifests = parse().entries.map(({ manifest }) => manifest);
    const exported = manifests.map(manifest => stringify(manifest)).join("---\n");
    const roundTripped = parse(exported);
    expect(roundTripped.entries.map(({ manifest }) => manifest)).toEqual(manifests);
    expect(ValidateManifestsUseCase.run({ parsed: roundTripped, siteLocales }).diagnostics).toEqual([]);
    expect(articleSchema().spec.schema["x-example-source"]).toBe("content/articles/*.md");
  });

  it("lets the host choose strict completeness or partial draft validation", () => {
    const validator = new EntryDataValidator();
    const schema = articleSchema();
    const draft = { slug: "example-article" };
    expect(validator.validate(schema, draft, { partial: true })).toEqual([]);
    expect(validator.validate(schema, draft).map(diagnostic => diagnostic.path))
      .toEqual(["/category", "/publishedAt"]);
    expect(validator.validate(schema, { ...draft, category: "updates", publishedAt: "2026-09-01" })).toEqual([]);
  });

  it("returns structured diagnostics for wrong nested and root types", () => {
    const validator = new EntryDataValidator();
    const schema = articleSchema();
    const invalid = validator.validate(schema, { attachments: [{ name: "Example", url: 42 }] }, { partial: true });
    expect(invalid).toEqual([expect.objectContaining({
      code: "INPUT_VALIDATION_FAILED", severity: "error", path: "/attachments/0/url",
    })]);
    expect(validator.validate(schema, [], { partial: true })).toEqual([
      expect.objectContaining({ code: "INPUT_VALIDATION_FAILED", path: "" }),
    ]);
  });

  it("accepts allowed legacy fields without writing or normalizing the host payload", () => {
    const payload = { slug: "example-article", legacyEditor: { label: "Keep this" } };
    const before = structuredClone(payload);
    expect(new EntryDataValidator().validate(articleSchema(), payload, { partial: true })).toEqual([]);
    expect(payload).toEqual(before);
    expect(payload.legacyEditor.label).toBe("Keep this");
  });

  it("rejects a broken translation parent at link time", () => {
    const parsed = parse(fixture.replace("parent: articles", "parent: missing-articles"));
    const result = ValidateManifestsUseCase.run({ parsed, siteLocales });
    expect(result.errorCount).toBeGreaterThan(0);
    expect(result.linked).toBeUndefined();
    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      code: "TRANSLATES_PARENT_UNKNOWN", severity: "error",
    }));
  });
});
