#!/usr/bin/env node
import { cpSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const clean = process.argv.includes("--clean");
// Invoked by packages/mantle pre/postpack with cwd = the package dir.
const packageRoot = process.cwd();

for (const dir of ["docs", "skills"]) {
  const target = resolve(packageRoot, dir);
  rmSync(target, { recursive: true, force: true });
  if (!clean) {
    cpSync(resolve(repoRoot, dir), target, { recursive: true });
  }
}
