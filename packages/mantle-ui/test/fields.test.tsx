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
