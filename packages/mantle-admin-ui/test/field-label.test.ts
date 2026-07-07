import { describe, expect, it } from "vitest";
import { fieldLabel, propertyDescription, propertyLabel } from "../src/lib/field-label";
import type { JsonSchema } from "../src/lib/types";

/**
 * #443 — label resolution for JSON Schema properties. `propertyLabel`
 * reads the standard `title` keyword (plain string or LocalizedText
 * locale-map, resolved for the viewer's language with the site
 * canonical locale as fallback) and falls back to `fieldLabel`'s
 * humanized property name — the exact pre-#443 behavior — when no
 * title is declared.
 *
 * #453 — extends the same resolution to the `description` keyword via
 * `propertyDescription`, so entry-editor field help text can be
 * localized the same way (previously only a plain string rendered;
 * a LocalizedText `description` was silently dropped).
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

describe("propertyDescription", () => {
  it("uses a plain string description as-is", () => {
    const schema: JsonSchema = {
      type: "string",
      description: "Optional join key into `categories.slug`.",
    };
    expect(propertyDescription(schema, "en", null)).toBe("Optional join key into `categories.slug`.");
  });

  it("resolves a LocalizedText description for the viewer's language", () => {
    const schema: JsonSchema = {
      type: "string",
      description: { en: "Join key into categories.slug.", "zh-TW": "對應分類 slug 的關聯鍵。" },
    };
    expect(propertyDescription(schema, "zh-TW", "en")).toBe("對應分類 slug 的關聯鍵。");
    expect(propertyDescription(schema, "en", "zh-TW")).toBe("Join key into categories.slug.");
  });

  it("falls back to the canonical locale when the viewer's language is absent", () => {
    const schema: JsonSchema = {
      type: "string",
      description: { "zh-TW": "對應分類 slug 的關聯鍵。" },
    };
    expect(propertyDescription(schema, "en", "zh-TW")).toBe("對應分類 slug 的關聯鍵。");
  });

  it("returns undefined when description is absent (no humanized-name fallback, unlike propertyLabel)", () => {
    const schema: JsonSchema = { type: "string" };
    expect(propertyDescription(schema, "en", null)).toBeUndefined();
  });

  it("returns undefined when the schema itself is undefined", () => {
    expect(propertyDescription(undefined, "en", null)).toBeUndefined();
  });
});
