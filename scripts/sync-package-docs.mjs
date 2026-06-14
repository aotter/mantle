#!/usr/bin/env node
import { cpSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const args = process.argv.slice(2);
const clean = args.includes("--clean");
const targetArg = args.find((arg) => arg !== "--clean") ?? "packages/mantle";
const packageRoot = resolve(process.cwd(), targetArg);

for (const dir of ["docs", "skills"]) {
  const target = resolve(packageRoot, dir);
  rmSync(target, { recursive: true, force: true });
  if (!clean) {
    cpSync(resolve(repoRoot, dir), target, { recursive: true });
  }
}
