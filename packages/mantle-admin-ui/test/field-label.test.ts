import { describe, expect, it } from "vitest";
import { fieldLabel, propertyLabel } from "../src/lib/field-label";
import type { JsonSchema } from "../src/lib/types";

/**
 * #443 — label resolution for JSON Schema properties. `propertyLabel`
 * reads the standard `title` keyword (plain string or LocalizedText
 * locale-map, resolved for the viewer's language with the site
 * canonical locale as fallback) and falls back to `fieldLabel`'s
 * humanized property name — the exact pre-#443 behavior — when no
 * title is declared.
 */

describe("fieldLabel", () => {
  it("title-cases camelCase names", () => {
    expect(fieldLabel("orderStatus")).toBe("Order Status");
  });

  it("title-cases snake_case and kebab-case names", () => {
    expect(fieldLabel("subtotal_minor")).toBe("Subtotal Minor");
    expect(fieldLabel("cover-asset-id")).toBe("Cover Asset Id");
  });
});

describe("propertyLabel", () => {
  it("uses a plain string title as-is", () => {
    const schema: JsonSchema = { type: "string", title: "訂單狀態" };
    expect(propertyLabel("orderStatus", schema, "en", null)).toBe("訂單狀態");
  });

  it("resolves a LocalizedText title for the viewer's language", () => {
    const schema: JsonSchema = {
      type: "string",
      title: { en: "Order Status", "zh-TW": "訂單狀態" },
    };
    expect(propertyLabel("orderStatus", schema, "zh-TW", "en")).toBe("訂單狀態");
    expect(propertyLabel("orderStatus", schema, "en", "zh-TW")).toBe("Order Status");
  });

  it("falls back to the canonical locale when the viewer's language is absent", () => {
    const schema: JsonSchema = {
      type: "string",
      title: { "zh-TW": "訂單狀態" },
    };
    expect(propertyLabel("orderStatus", schema, "en", "zh-TW")).toBe("訂單狀態");
  });

  it("falls back to the first locale entry when neither language nor canonical match", () => {
    const schema: JsonSchema = {
      type: "string",
      title: { ja: "注文状況", "zh-TW": "訂單狀態" },
    };
    expect(propertyLabel("orderStatus", schema, "en", null)).toBe("注文状況");
  });

  it("falls back to the humanized name when title is absent (pre-#443 behavior)", () => {
    const schema: JsonSchema = { type: "string" };
    expect(propertyLabel("orderStatus", schema, "en", null)).toBe("Order Status");
    expect(propertyLabel("subtotal_minor", schema, "zh-TW", null)).toBe("Subtotal Minor");
  });

  it("falls back to the humanized name when the schema itself is undefined", () => {
    expect(propertyLabel("skuCode", undefined, "en", null)).toBe("Sku Code");
  });
});
