#!/usr/bin/env node
// Generates every host plugin manifest from package identity and the richest
// host manifest. Nothing shared is hand-bumped per host.
//
//   node scripts/sync-plugin-manifests.mjs          write
//   node scripts/sync-plugin-manifests.mjs --check  fail when stale
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const check = process.argv.includes("--check");
const read = (path) => JSON.parse(readFileSync(join(repoRoot, path), "utf8"));

const pkg = read("packages/mantle/package.json");
const presentation = read(".codex-plugin/plugin.json");

const shared = {
  name: "mantle",
  description: presentation.description,
  version: pkg.version,
  author: { name: "Aotter" },
  homepage: pkg.homepage,
  repository: "https://github.com/aotter/mantle",
  license: pkg.license,
  keywords: ["mantle", "cms", "agent-skills", "marketplace", "sdk"],
};
const version = shared.version;

const manifests = {
  ".claude-plugin/plugin.json": shared,
  ".claude-plugin/marketplace.json": {
    name: shared.name,
    owner: shared.author,
    description: shared.description,
    plugins: [{ name: shared.name, source: "./", description: shared.description }],
  },
  ".codex-plugin/plugin.json": {
    ...shared,
    author: { ...shared.author, url: shared.homepage },
    skills: "./skills/",
    interface: {
      ...presentation.interface,
      websiteURL: shared.homepage,
    },
  },
  ".cursor-plugin/plugin.json": { ...shared, displayName: presentation.interface.displayName, skills: "./skills/" },
  ".copilot-plugin/plugin.json": { ...shared, skills: "./skills/" },
  // The marketplace ref is derived from the package version: this is the file
  // that used to need a hand-edit on every release.
  ".agents/plugins/marketplace.json": {
    name: shared.name,
    interface: { displayName: presentation.interface.displayName },
    plugins: [{
      name: shared.name,
      source: { source: "url", url: `${shared.repository}.git`, ref: `v${version}` },
      policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
      category: presentation.interface.category,
    }],
  },
};

const stale = [];
for (const [path, value] of Object.entries(manifests)) {
  const expected = `${JSON.stringify(value, null, 2)}\n`;
  const current = (() => {
    try {
      return readFileSync(join(repoRoot, path), "utf8");
    } catch {
      return null;
    }
  })();
  if (current === expected) continue;
  if (check) {
    stale.push(path);
    continue;
  }
  writeFileSync(join(repoRoot, path), expected, "utf8");
}

if (check && stale.length > 0) {
  console.error(
    `sync-plugin-manifests: ${stale.length} stale manifest(s)\n${stale.map((path) => `  ${path}`).join("\n")}\n`
      + "Run `node scripts/sync-plugin-manifests.mjs`.",
  );
  process.exit(1);
}
console.log(
  check
    ? `sync-plugin-manifests: ${Object.keys(manifests).length} manifests match v${version}`
    : `sync-plugin-manifests: wrote ${Object.keys(manifests).length} manifests for v${version}`,
);
