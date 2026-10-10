import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MANTLE_VERSION } from "../../src/core/version.js";

describe("MANTLE_VERSION", () => {
  it("equals the package version, so `plan.lowered.mantle` names the build that printed the statements", () => {
    const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string };
    expect(MANTLE_VERSION).toBe(pkg.version);
  });
});
