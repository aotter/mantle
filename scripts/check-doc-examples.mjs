#!/usr/bin/env node
// Every example page under docs/examples/ is a whole service: its ```yaml blocks are the manifests. Each page is compiled by the
// built `mantle` CLI in a scratch project (`generate`, then `generate --check`), so a page that stops compiling, or compiles with a warning, fails `pnpm check`.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const examples = join(root, "docs/examples");
const cli = join(root, "packages/mantle/dist/cli/main.js");
const pages = process.argv.slice(2).length
  ? process.argv.slice(2).map((path) => resolve(path))
  : readdirSync(examples).filter((name) => name.endsWith(".md") && name !== "README.md").map((name) => join(examples, name));

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
    // identity none and REST only: the page's manifests are what is checked, not the peers a fuller selection needs
    // a warning fails too: an example teaches what a clean manifest looks like
    for (const args of [["generate", "--identity", "none", "--features", "web"], ["generate", "--check"]]) {
      const run = spawnSync(process.execPath, [cli, ...args], { cwd: project, encoding: "utf8" });
      if (run.status !== 0 || /^warning:/m.test(run.stdout + run.stderr)) {
        failures.push(`${page}: mantle ${args.join(" ")}\n${run.stdout}${run.stderr}`);
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
