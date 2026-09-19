import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("ships the authoring CLI without scaffold or bundle-update side effects", () => {
  const cli = fileURLToPath(new URL("../../dist/cli/main.js", import.meta.url));
  const root = mkdtempSync(join(tmpdir(), "mantle-cli-surface-"));
  try {
    const help = execFileSync(process.execPath, [cli, "--help"], { cwd: root, encoding: "utf8" });
    expect(help).toContain("Overview");
    expect(help).toContain("opt-in");
    expect(help).toContain("Minimal");
    expect(help).toContain("Runtime / adapter");
    expect(help).toContain("Admin / Dev UI");
    expect(help).toContain("docs/examples/minimal-worker");
    expect(help).toContain("docs/examples/local-admin-otp");
    expect(help).toContain("node_modules/@aotter/mantle/docs/examples/minimal-worker");
    expect(help).toContain("node_modules/@aotter/mantle/docs/examples/local-admin-otp");
    expect(help).toContain("generate");
    expect(help).toContain("validate");
    expect(help).not.toMatch(/\b(create|update|blank|template)\b/);
    for (const args of [["create", "blank", "site"], ["update", "--ref", "v0.1.2"]]) {
      const result = spawnSync(process.execPath, [cli, ...args], { cwd: root, encoding: "utf8" });
      expect(result.status).toBe(2);
      expect(result.stderr).toContain(`Unknown subcommand: ${args[0]}`);
    }
    expect(readdirSync(root)).toEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
