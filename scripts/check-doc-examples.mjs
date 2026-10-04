#!/usr/bin/env node
// Every example page under docs/examples/ (and the HANDBOOK pages below) is a whole service: its ```yaml blocks are the manifests. Each page is compiled by the
// built `mantle` CLI in a scratch project (`generate`, then `generate --check`), so a page that stops compiling, or compiles with a warning, fails `pnpm check`. Each scratch project also exercises the
// plugin's Cloud helper (skills/mantle/scripts/mantle-cloud.mjs).
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const examples = join(root, "docs/examples");
const cli = join(root, "packages/mantle/dist/cli/main.js");
const cloudHelper = join(root, "skills/mantle/scripts/mantle-cloud.mjs");
// handbook pages whose yaml blocks are a whole service too
const HANDBOOK = ["start/quickstart-worker.md", "guides/typed-queries.md", "guides/admin-ui.md"];
const pages = process.argv.slice(2).length
  ? process.argv.slice(2).map((path) => resolve(path))
  : [
      ...readdirSync(examples).filter((name) => name.endsWith(".md") && name !== "README.md").map((name) => join(examples, name)),
      ...HANDBOOK.map((page) => join(root, "docs/handbook", page)),
    ];

const failures = [];
for (const page of pages) {
  const blocks = [...readFileSync(page, "utf8").matchAll(/^```yaml\n([\s\S]*?)^```$/gm)].map((match) => match[1]);
  if (!blocks.some((block) => block.includes("apiVersion: cms.mantle.aotter.net/v2"))) {
    failures.push(`${page}: no v2 manifest block`);
    continue;
  }
  const project = mkdtempSync(join(tmpdir(), "mantle-doc-example-"));
  try {
    mkdirSync(join(project, "manifests"));
    mkdirSync(join(project, "node_modules/@aotter"), { recursive: true });
    symlinkSync(join(root, "packages/mantle"), join(project, "node_modules/@aotter/mantle"), "dir");
    writeFileSync(join(project, "package.json"), '{ "type": "module" }\n');
    blocks.forEach((block, index) => writeFileSync(join(project, "manifests", `${index}.yaml`), block));
    // identity none and REST only, on SQLite named as `mantle generate --dialect sqlite` writes it: the page's manifests are what is checked, not the peers a fuller selection needs
    // a warning fails too: an example teaches what a clean manifest looks like. The plugin's Cloud helper must then compile the
    // same plan through the project's installed Core and find plan.json fresh.
    for (const args of [[cli, "generate", "--identity", "none", "--features", "web", "--dialect", "sqlite"], [cli, "generate", "--check"], [cloudHelper, "check"]]) {
      const run = spawnSync(process.execPath, args, { cwd: project, encoding: "utf8" });
      if (run.status !== 0 || /^warning:/m.test(run.stdout + run.stderr)) {
        failures.push(`${page}: ${args.slice(1).join(" ")}\n${run.stdout}${run.stderr}`);
        break;
      }
    }
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
}

if (failures.length) {
  console.error(`check-doc-examples: ${failures.length} page(s) failed\n${failures.join("\n")}`);
  process.exit(1);
}
console.log(`check-doc-examples: ${pages.length} page(s) compile`);
