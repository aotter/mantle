#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const reference = join(root, "docs/examples/host-minimal-worker");
const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
const registry = process.argv[2] === "--registry" && process.argv[3] === version;
if (process.argv.length !== 2 && !(registry && process.argv.length === 4)) {
  throw new Error("Usage: check-worker-consumer.mjs [--registry <exact Core version>]");
}
const env = { ...process.env, WRANGLER_SEND_METRICS: "false" };
const run = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, env, stdio: "inherit", timeout: 300_000 });
if (!registry) {
  run(process.execPath, [join(root, "scripts/check-packed-consumer.mjs"), "--project", reference, "--", "pnpm", "check"], root);
} else {
  const temp = mkdtempSync(join(tmpdir(), "mantle-registry-consumer-"));
  try {
    const archive = execFileSync("git", ["archive", "HEAD:docs/examples/host-minimal-worker"], { cwd: root });
    execFileSync("tar", ["-x", "-C", temp], { input: archive });
    const path = join(temp, "package.json");
    const pkg = JSON.parse(readFileSync(path, "utf8"));
    for (const name of Object.keys(pkg.dependencies)) {
      if (name === "@aotter/mantle" || name.startsWith("@aotter/mantle-")) pkg.dependencies[name] = version;
    }
    writeFileSync(path, JSON.stringify(pkg, null, 2) + "\n");
    run("pnpm", ["install", "--no-frozen-lockfile"], temp);
    for (const name of Object.keys(pkg.dependencies).filter((name) => name.startsWith("@aotter/mantle"))) {
      const installed = JSON.parse(readFileSync(join(temp, "node_modules", name, "package.json"), "utf8"));
      if (installed.version !== version) throw new Error(`Unexpected ${name}@${installed.version}`);
    }
    run("pnpm", ["check"], temp);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}
