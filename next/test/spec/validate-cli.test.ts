import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { parseArgs, run } from "../../src/spec/infrastructure/cli/ValidateCommand.js";

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

describe("run — SQL", () => {
  it("compiles View and Procedure SQL, so a refusal fails validate with its SQL code", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mantle-validate-"));
    const view = (sql: string) => `apiVersion: cms.mantle.aotter.net/v2
kind: Schema
metadata: { name: notes }
spec: { title: Notes, schema: { type: object, properties: { body: { type: string } } } }
---
apiVersion: cms.mantle.aotter.net/v2
kind: View
metadata: { name: v }
spec: { surface: staff, sql: "${sql}" }
`;
    const out: string[] = [];
    const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => (out.push(String(chunk)), true));
    try {
      await writeFile(join(dir, "ok.yaml"), view("SELECT id FROM notes"));
      expect(await run(["--manifests", dir, "--json", "--no-source"])).toBe(0);
      await writeFile(join(dir, "ok.yaml"), view("SELECT id FROM notes OFFSET 1"));
      out.length = 0;
      expect(await run(["--manifests", dir, "--json", "--no-source"])).toBe(1);
      expect(JSON.parse(out.join("")).diagnostics[0]).toMatchObject({ code: "SQL_UNSUPPORTED" });
    } finally {
      spy.mockRestore();
    }
  });
});
