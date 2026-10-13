import { describe, expect, it } from "vitest";
import { isIdField, shortenId } from "../src/ui/id-value";

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
