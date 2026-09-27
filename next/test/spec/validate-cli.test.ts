import { describe, expect, it } from "vitest";
import { parseArgs } from "../../src/spec/infrastructure/cli/ValidateCommand.js";

/**
 * `mantle validate` CLI argument parsing — the surface that maps user
 * flags into the typed `CliArgs` the runner consumes. Behavioural
 * checks for the phase filter (which diagnostic codes are suppressed
 * in which phase) belong to the runner's integration tests; this file
 * only covers parse-time defaults + rejections.
 */
describe("parseArgs — phase", () => {
  it("defaults to preview when --phase is not supplied", () => {
    expect(parseArgs([]).phase).toBe("preview");
  });

  it("accepts --phase preview explicitly", () => {
    expect(parseArgs(["--phase", "preview"]).phase).toBe("preview");
  });

  it("accepts --phase deploy", () => {
    expect(parseArgs(["--phase", "deploy"]).phase).toBe("deploy");
  });

  it("rejects an unknown phase value with a descriptive error", () => {
    expect(() => parseArgs(["--phase", "ready"])).toThrowError(/--phase must be/);
  });

  it("rejects a missing phase value", () => {
    expect(() => parseArgs(["--phase"])).toThrowError(/--phase must be/);
  });
});

describe("parseArgs — backwards-compatible flags", () => {
  it("preserves --format and --json", () => {
    expect(parseArgs(["--format", "json"]).format).toBe("json");
    expect(parseArgs(["--json"]).format).toBe("json");
  });

  it("preserves --manifests and --source / --no-source", () => {
    expect(parseArgs(["--manifests", "yamls"]).manifests).toBe("yamls");
    expect(parseArgs(["--source", "lib"]).source).toBe("lib");
    expect(parseArgs(["--no-source"]).source).toBeNull();
  });

  it("rejects unknown flags", () => {
    expect(() => parseArgs(["--bogus"])).toThrowError(/Unknown argument/);
  });
});
