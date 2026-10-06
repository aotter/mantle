import { describe, expect, it } from "vitest";

import { readViewParams } from "../src/features/ops/view-page";

describe("readViewParams", () => {
  it("reads a URL parameter as its declared type, a nullable one too", () => {
    const schema = { type: "object", properties: { min: { type: ["integer", "null"] }, on: { type: "boolean" }, q: { type: "string" } } } as const;
    expect(readViewParams(schema as never, new URLSearchParams("min=3&on=true&q=tea"))).toEqual({ min: 3, on: true, q: "tea" });
  });
});
