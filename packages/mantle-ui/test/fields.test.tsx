import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { renderDataValue, type FieldSchema } from "../src/index.js";
import { SchemaFields } from "../src/kit/index.js";

const schema: FieldSchema = {
  type: "object",
  required: ["decision"],
  properties: {
    decision: { type: "string", title: { en: "Decision", "zh-TW": "決定" }, oneOf: [{ const: "approved", title: { "zh-TW": "核准" } }, { const: "rejected" }] },
    note: { type: "string", "x-mcp-hint": "markdown" },
    total: { type: "integer", "x-mcp-hint": "money-minor" },
    cover: { type: "string", "x-mantle-ref": { schema: "media_assets", field: "id" } },
  },
};
const render = (props: Partial<Parameters<typeof SchemaFields>[0]> = {}) =>
  renderToStaticMarkup(<SchemaFields schema={schema} value={{ total: 12345, currency: "TWD" }} onChange={() => {}} language="zh-TW" {...props} />);

describe("SchemaFields", () => {
  it("labels fields by title in the language and previews money", () => {
    const html = render();
    expect(html).toContain("決定");
    expect(html).toMatch(/= .*123\.45/);
  });

  it("lets a host render a field itself, and falls back to a textarea for markdown without one", () => {
    expect(render()).toContain("<textarea");
    const html = render({ renderField: (f) => (f.name === "cover" ? <em>media-picker</em> : f.widget === "markdown" ? <em>editor</em> : undefined) });
    expect(html).toContain("<em>media-picker</em>");
    expect(html).toContain("<em>editor</em>");
    expect(html).not.toContain("<textarea");
  });

  it("hides root fields a host binds", () => {
    expect(render({ hiddenRootFields: ["decision"] })).not.toContain("決定");
  });
});

describe("renderDataValue", () => {
  it("shows an option's title and a placeholder for nothing", () => {
    expect(renderToStaticMarkup(<>{renderDataValue(schema.properties!.decision, "approved", "zh-TW")}</>)).toBe("核准");
    expect(renderToStaticMarkup(<>{renderDataValue(schema.properties!.decision, "", "zh-TW")}</>)).toContain(">-<");
  });
});

describe("the root entry", () => {
  it("needs only React: the kit-built form lives on /kit", async () => {
    const root = await import("../src/index.js");
    expect(root).not.toHaveProperty("SchemaFields");
    expect(root).toHaveProperty("renderDataValue");
  });
});

describe("SchemaFields labels", () => {
  it("reads a label the host resolves", () => {
    const html = renderToStaticMarkup(<SchemaFields schema={{ type: "object", properties: { createdAt: { type: "string" } } }} value={{}} onChange={() => {}} language="en"
      propertyLabel={(name) => (name === "createdAt" ? "Created" : name)} />);
    expect(html).toContain("Created");
  });
});

describe("SchemaFields values and access", () => {
  it("keeps an option's declared type, and clears to null only where null is a value", async () => {
    const { clearedValue, optionValue } = await import("../src/react/fields.js");
    expect(optionValue({ type: "integer", enum: [1, 2, 3] }, "2")).toBe(2);
    expect(optionValue({ type: "string", oneOf: [{ const: "a" }] }, "a")).toBe("a");
    expect(clearedValue({ type: "integer" })).toBeUndefined();
    expect(clearedValue({ type: ["integer", "null"] })).toBeNull();
    expect(clearedValue({ type: "string", enum: ["a", null] })).toBeNull();
  });

  it("clears unless required, and hints a default for a missing value without selecting it", async () => {
    const { enumChoice } = await import("../src/react/fields.js");
    const grid = { type: "string", enum: ["grid", "carousel"] } as const;
    const withDefault = { ...grid, default: "grid" };
    expect(enumChoice(grid, undefined, false)).toEqual({ selected: "__empty__", clearable: true });
    expect(enumChoice(grid, undefined, true)).toEqual({ selected: "", clearable: false });
    expect(enumChoice({ ...grid, enum: ["grid", null] }, undefined, true).clearable).toBe(true);
    // required: nothing selected, the default is the placeholder's hint
    expect(enumChoice(withDefault, undefined, true)).toEqual({ selected: "", clearable: false, defaultOption: "grid" });
    // optional and nullable: still clearable, and the empty item carries the hint
    expect(enumChoice({ ...withDefault, nullable: true }, undefined, false)).toEqual({ selected: "__empty__", clearable: true, defaultOption: "grid" });
    // a stored null is a choice, and a stored value is shown as itself
    expect(enumChoice(withDefault, null, false)).toEqual({ selected: "__empty__", clearable: true });
    expect(enumChoice(withDefault, "carousel", true)).toEqual({ selected: "carousel", clearable: false });
    // a default that is not an option is ignored
    expect(enumChoice({ ...grid, default: "list" }, undefined, true)).toEqual({ selected: "", clearable: false });
  });

  it("shows a readOnly property read-only, and links each label to its control and description", () => {
    const html = renderToStaticMarkup(<SchemaFields schema={{ type: "object", required: ["note"], properties: { locked: { type: "string", readOnly: true }, note: { type: "string", description: "Why" } } }} value={{ locked: "x" }} onChange={() => {}} language="en" />);
    expect(html).toMatch(/role="textbox" aria-readonly="true"/);
    const id = /<label id="([^"]+)-label" for="\1"[^>]*>Note/.exec(html)?.[1];
    expect(id).toBeTruthy();
    expect(html).toContain(`id="${id}" aria-describedby="${id}-description" aria-required="true"`);
  });
});

describe("resolveLocalizedText", () => {
  it("finds a region's language, ignores case, then the canonical language, then English, then the first", async () => {
    const { resolveLocalizedText } = await import("../src/react/values.js");
    const t = { "zh-TW": "品項", en: "Item" };
    expect(resolveLocalizedText(t, "en-US")).toBe("Item");
    expect(resolveLocalizedText(t, "zh-tw")).toBe("品項");
    expect(resolveLocalizedText(t, "fr")).toBe("Item");
    expect(resolveLocalizedText({ "zh-TW": "品項", ja: "品目" }, "fr", "ja")).toBe("品目");
    expect(resolveLocalizedText({ "zh-TW": "品項" }, "fr")).toBe("品項");
  });
});

 it("renders boolean values in the reader's language", () => {
   expect(renderDataValue({ type: "boolean" }, true, "zh-TW")).toBe("是");
   expect(renderDataValue({ type: "boolean" }, false, "zh-TW")).toBe("否");
   expect(renderDataValue({ type: "boolean" }, false, "en")).toBe("No");
 });
