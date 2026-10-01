import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { enumOptions, optionLabel } from "../src/lib/enum-options";
import { renderDataValue, withNativeSchema } from "../src/lib/render-data-value";
import type { JsonSchema } from "../src/lib/types";

const status: JsonSchema = { type: "string", oneOf: [{ const: "submitted", title: { en: "Submitted", "zh-TW": "已送出" } }, { const: "approved" }] };

describe("enum options", () => {
  it("reads an enum or a oneOf of string consts, with titles", () => {
    expect(enumOptions({ enum: ["a", "b"] })).toEqual([{ value: "a" }, { value: "b" }]);
    expect(enumOptions(status)?.map((o) => o.value)).toEqual(["submitted", "approved"]);
    expect(enumOptions({ oneOf: [{ type: "string" }, { type: "null" }] })).toBeUndefined();
  });

  it("labels an option by its title in the language, else humanizes the value", () => {
    expect(optionLabel(status, "submitted", "zh-TW")).toBe("已送出");
    expect(optionLabel(status, "approved", "zh-TW")).toBe("Approved");
    expect(renderToStaticMarkup(<>{renderDataValue(status, "submitted", "zh-TW")}</>)).toBe("已送出");
    expect(renderToStaticMarkup(<>{renderDataValue(status, "", "zh-TW")}</>)).toContain(">-<");
  });
});

describe("timestamps", () => {
  it("renders a date-time and the entry's own timestamps as a time, not the raw string", () => {
    const html = renderToStaticMarkup(<>{renderDataValue(withNativeSchema("createdAt", undefined), "2026-10-01T09:30:00.000000Z")}</>);
    expect(html).toMatch(/^<time dateTime="2026-10-01T09:30:00.000000Z">/);
    expect(withNativeSchema("title", undefined)).toBeUndefined();
  });
});
