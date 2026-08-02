#!/usr/bin/env node
import { cpSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const clean = process.argv.includes("--clean");
// Invoked by packages/mantle pre/postpack with cwd = the package dir.
const packageRoot = process.cwd();

for (const dir of ["docs", "skills", "fixtures/low-level-worker"]) {
  const target = resolve(packageRoot, dir);
  rmSync(target, { recursive: true, force: true });
  if (!clean) {
    cpSync(resolve(repoRoot, dir), target, { recursive: true });
  }
}

if (!clean) {
  const packageManifest = JSON.parse(readFileSync(resolve(packageRoot, "package.json"), "utf8"));
  const fixturePath = resolve(packageRoot, "fixtures/low-level-worker/package.json");
  const fixtureManifest = JSON.parse(readFileSync(fixturePath, "utf8"));
  fixtureManifest.dependencies["@aotter/mantle"] = packageManifest.version;
  writeFileSync(fixturePath, `${JSON.stringify(fixtureManifest, null, 2)}\n`);
}
