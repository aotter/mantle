import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("ships progressive generate without separate create or update commands", () => {
  const cli = fileURLToPath(new URL("../../dist/cli/main.js", import.meta.url));
  const root = mkdtempSync(join(tmpdir(), "mantle-cli-surface-"));
  try {
    const help = execFileSync(process.execPath, [cli, "--help"], { cwd: root, encoding: "utf8" });
    expect(help).toContain("Overview");
    expect(help).toContain("New applications default to Spec, Runtime, API, MCP, Admin");
    expect(help).toContain("Host-free — Spec only");
    expect(help).toContain("Runtime / adapter");
    expect(help).toContain("Selected Admin / Dev UI");
    expect(help).toContain("docs/examples/host-minimal-worker");
    expect(help).toContain("docs/examples/host-local-admin-otp");
    expect(help).toContain("node_modules/@aotter/mantle/docs/examples/host-minimal-worker");
    expect(help).toContain("node_modules/@aotter/mantle/docs/examples/host-local-admin-otp");
    expect(help).toContain("docs/handbook/start/overview.md");
    expect(help).toContain("docs/handbook/reference/features.md");
    expect(help).toContain("docs/handbook/guides/admin-ui.md");
    expect(help).toContain("generate");
    expect(help).toContain("validate");
    const generateHelp = execFileSync(process.execPath, [cli, "generate", "--help"], { cwd: root, encoding: "utf8" });
    expect(generateHelp).toContain("--features <list>");
    expect(generateHelp).toContain("--host <name>");
    expect(help).not.toMatch(/\b(create|update|template)\b/);
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
