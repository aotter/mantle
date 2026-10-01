#!/usr/bin/env node
// Invoked by packages/mantle pre/postpack with cwd = the package dir. Ships the docs that describe 0.2.0: the upgrade guide, the
// ADRs, the handbook, the examples and the package skills. The other top-level docs/*.md are contributor notes from 0.1.x and stay out.
import { cpSync, rmSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageRoot = process.cwd();
const target = resolve(packageRoot, "docs");
const SHIPPED = ["upgrade-0.1-to-0.2.md", "adr", "handbook", "examples", "skills"];
// Runnable docs may have been installed or run locally; never publish that state.
const LOCAL = ["node_modules", ".wrangler", ".dev.vars", "pnpm-lock.yaml"];

rmSync(target, { recursive: true, force: true });
if (!process.argv.includes("--clean")) {
  for (const path of SHIPPED) {
    cpSync(resolve(repoRoot, "docs", path), resolve(target, path), { recursive: true, filter: (p) => !LOCAL.includes(basename(p)) });
  }
}
