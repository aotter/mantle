import { expect, it } from "vitest";
import { resolveLocalizedText } from "../../src/spec/domain/model/ManifestGrammar.js";
import { parseManifests } from "./parse.js";

// LocalizedText (#430, #443, #453, ADR-0029): a non-empty string, or a non-empty map of locale to non-empty string.

it.each([
  ["Products", "zh-TW", undefined, "Products"],
  [{ en: "Products", "zh-TW": "商品" }, "zh-TW", undefined, "商品"],
  [{ en: "Products", "zh-TW": "商品", ja: "製品" }, "ja", "en", "製品"], // preferred beats canonical
  [{ en: "Products", "zh-TW": "商品" }, "ja", "en", "Products"], // then canonical
  [{ fr: "Produits", de: "Produkte" }, "ja", "en", "Produits"], // then the first entry
  [null, "en", undefined, null],
  [undefined, "en", undefined, null],
] as const)("resolveLocalizedText(%j, %s, %s) is %j", (value, preferred, canonical, out) => {
  expect(resolveLocalizedText(value as never, preferred, canonical)).toBe(out);
});

const DOC = {
  Schema: (f: string) => `kind: Schema\nmetadata: { name: posts }\nspec: { ${f}schema: { type: object } }`,
  Procedure: (f: string) => `kind: Procedure\nmetadata: { name: doThing }\nspec: { ${f}input: { type: object }, output: { type: object }, handler: { ref: doThing } }`,
  View: (f: string) => `kind: View\nmetadata: { name: postsRecent }\nspec: { ${f}surface: public, sql: "SELECT p.id FROM posts p" }`,
};
const parse = (kind: keyof typeof DOC, field: string, value: unknown) =>
  parseManifests(`apiVersion: cms.mantle.aotter.net/v2\n${DOC[kind](`${kind === "Schema" && field !== "title" ? "title: Posts, " : ""}${value === undefined ? "" : `${field}: ${JSON.stringify(value)}, `}`)}`);

it.each(
  (["Schema", "Procedure", "View"] as const).flatMap((kind) =>
    ["title", "description"].flatMap((field) => [
      ...(["Posts", { en: "Posts", "zh-TW": "文章" }] as unknown[]).map((v) => [kind, field, v, true] as const),
      ...(["", {}, { en: "Posts", "zh-TW": 42 }, ["Posts"], 42] as unknown[]).map((v) => [kind, field, v, false] as const),
      [kind, field, undefined, !(kind === "Schema" && field === "title")] as const, // only a Schema must have a title
    ]),
  ),
)("%s.spec.%s = %j is accepted: %s", (kind, field, value, ok) => {
  const { manifests, diagnostics } = parse(kind, field, value);
  if (ok) {
    expect(diagnostics).toEqual([]);
    expect((manifests[0]!.spec as Record<string, unknown>)[field]).toEqual(value);
  } else {
    expect(diagnostics[0]?.path).toContain(`/spec/${field}`);
  }
});

it("a Schema property's JSON Schema title and description may be LocalizedText", () => {
  const { diagnostics } = parseManifests(`apiVersion: cms.mantle.aotter.net/v2
kind: Schema
metadata: { name: posts }
spec:
  title: Posts
  schema: { type: object, properties: { a: { type: string, title: A, description: { en: A, zh-TW: 甲 } } } }`);
  expect(diagnostics).toEqual([]);
});
