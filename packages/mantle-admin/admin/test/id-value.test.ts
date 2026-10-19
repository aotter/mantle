import { describe, expect, it } from "vitest";
import { isIdField, shortenId } from "../src/ui/id-value";
import { idTail } from "../src/features/content/field-render";
describe("ID values", () => {
  it("recognizes declared and conventional IDs and shortens long values", () => {
    expect(isIdField("id")).toBe(true);
    expect(isIdField("userId")).toBe(true);
    expect(isIdField("owner_id")).toBe(true);
    expect(isIdField("organization", { "x-mantle-ref": "organizations" })).toBe(true);
    expect(isIdField("description")).toBe(false);
    expect(shortenId("RgOVVrmhe13q6TCIKMrlN9FhixGyeDLI")).toBe("RgOVVrm…GyeDLI");
  });
});

describe("idTail", () => {
  it("returns the last N characters, not the first", () => {
    expect(idTail("entry_o_9f2c8b1a4d3e", 8)).toBe("8b1a4d3e");
    expect(idTail("entry_o_9f2c8b1a4d3e", 8)).not.toBe("entry_o_");
  });

  it("returns the id unchanged when it's already shorter than the requested length", () => {
    expect(idTail("short", 8)).toBe("short");
  });
});
